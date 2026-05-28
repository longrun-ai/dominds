import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';

import type {
  DomindsRuntimeMode,
  DomindsSelfUpdateAction,
  DomindsSelfUpdateBusy,
  DomindsSelfUpdateReason,
  DomindsSelfUpdateRunKind,
  DomindsSelfUpdateStatus,
} from '@longrun-ai/kernel/types';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import { createLogger } from '../log';
import { DOMINDS_RUNNING_VERSION } from './dominds-running-version';
import type { RestartHelperPayload } from './dominds-self-update-restart-helper';

const log = createLogger('dominds-self-update');
const BACKGROUND_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LATEST_VERSION_CHECK_TIMEOUT_MS = 60_000;
const RESTART_PORT_RELEASE_TIMEOUT_MS = 15_000;
const RESTART_PORT_PROBE_INTERVAL_MS = 150;
const RESTART_EXIT_GRACE_MS = 1_000;
const RESTART_FORCE_KILL_AFTER_MS = 30_000;
const COMMAND_OUTPUT_LOG_LIMIT = 2_000;
const PROXY_URL_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
]);

type ServerMode = 'development' | 'production';
type RuntimeConfig = Readonly<{
  host: string;
  port: number;
  mode: ServerMode;
  closeWebSocketClients: () => void;
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
  durationMs: number | null;
  timeoutMs: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
  capturedOutputChars: number | null;
  maxBuffer: number | null;
  proxyEnvSummary: Record<string, string>;
}>;

type PackageManagerCommandSpec = Readonly<{
  command: string;
  args: readonly string[];
  display: string;
}>;

type PackageManagerCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type DomindsCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

type RestartLaunchSpec = Readonly<{
  command: string;
  args: readonly string[];
}>;

type NpxDomindsSpec =
  | Readonly<{ kind: 'latest' }>
  | Readonly<{ kind: 'versionless' }>
  | Readonly<{ kind: 'fixed'; spec: string }>;

type GlobalInstallManager = 'npm' | 'pnpm';

type GlobalInstallTargetVerification =
  | Readonly<{
      kind: 'ok';
      manager: GlobalInstallManager;
      currentPackageRootAbs: string;
      managerPackageRootAbs: string;
    }>
  | Readonly<{
      kind: 'unsupported';
      message: string;
      currentPackageRootAbs: string | null;
      checkedTargets: readonly string[];
    }>;

type InstalledDomindsVerification =
  | Readonly<{
      kind: 'ok';
      packageVersion: string;
      probeVersion: string;
    }>
  | Readonly<{
      kind: 'failed';
      message: string;
      packageVersion: string | null;
      probeVersion: string | null;
    }>;

type RestartState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'restart_required';
      installedVersion: string;
      installReport: string | null;
      reason: Extract<
        DomindsSelfUpdateReason,
        'restart_required' | 'install_verified_after_command_failure'
      >;
    }>
  | Readonly<{ kind: 'restarting'; targetVersion: string | null }>;

type InstallFailureObservation = Readonly<{ errorText: string; failedAt: string }>;

type RestartStdioMode = 'inherit' | 'ignore';
type RestartTraceContext = Readonly<{
  debugDir: string;
  traceFile: string;
}>;

const IDLE_RESTART_STATE: RestartState = { kind: 'idle' };
const PROCESS_START_ARGV = [...process.argv];
const PROCESS_START_EXEC_ARGV = [...process.execArgv];
const PROCESS_START_CWD = process.cwd();

let runtimeConfig: RuntimeConfig | null = null;
let latestObservation: LatestObservation = { kind: 'unknown' };
let backgroundCheckTimer: ReturnType<typeof setTimeout> | null = null;
let installPromise: Promise<DomindsSelfUpdateStatus> | null = null;
let restartPromise: Promise<DomindsSelfUpdateStatus> | null = null;
let restartState: RestartState = IDLE_RESTART_STATE;
let installFailureObservation: InstallFailureObservation | null = null;
let broadcastStatusUpdate: ((status: DomindsSelfUpdateStatus) => void) | null = null;
let activeRestartTraceFile: string | null = null;

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
  const scriptPath = (PROCESS_START_ARGV[1] ?? '').replace(/\\/g, '/');
  if (scriptPath.includes('/_npx/') && scriptPath.includes('/node_modules/dominds/')) {
    return 'npx';
  }
  return 'global';
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

function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sanitizeDebugFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized.slice(0, 80) : 'unknown';
}

function buildRestartTraceContext(): RestartTraceContext {
  const capturedAt = formatUnifiedTimestamp(new Date());
  const debugDir = path.resolve(process.cwd(), '.dialogs', 'debug');
  const traceFile = path.join(
    debugDir,
    [
      'dominds-self-update-restart',
      sanitizeDebugFileSegment(capturedAt),
      String(process.pid),
      `${randomUUID()}.jsonl`,
    ].join('-'),
  );
  return { debugDir, traceFile };
}

function getRestartHelperEntrypoint(): string {
  return path.resolve(__dirname, 'dominds-self-update-restart-helper.js');
}

async function appendRestartTrace(
  trace: RestartTraceContext,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    ...details,
    event,
    capturedAt: formatUnifiedTimestamp(new Date()),
    pid: process.pid,
    platform: process.platform,
    rtwsRootAbs: process.cwd(),
  };
  await fsPromises.mkdir(trace.debugDir, { recursive: true });
  await fsPromises.appendFile(trace.traceFile, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function appendRestartTraceSoon(
  trace: RestartTraceContext,
  event: string,
  details: Record<string, unknown> = {},
): void {
  void appendRestartTrace(trace, event, details).catch((error: unknown) => {
    log.warn('Failed to write Dominds restart trace', error, {
      traceFile: trace.traceFile,
      event,
    });
  });
}

async function appendRestartTraceBestEffort(
  trace: RestartTraceContext,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendRestartTrace(trace, event, details);
  } catch (error: unknown) {
    log.warn('Failed to write Dominds restart trace', error, {
      traceFile: trace.traceFile,
      event,
    });
  }
}

async function getComparableRealPath(absPath: string): Promise<string> {
  try {
    return normalizeComparablePath(await fsPromises.realpath(absPath));
  } catch (error: unknown) {
    const code = getStringErrorProp(error, 'code');
    if (code === 'ENOENT') return normalizeComparablePath(path.resolve(absPath));
    throw error;
  }
}

function getCurrentProcessEntrypoint(): string {
  const entrypoint = PROCESS_START_ARGV[1];
  if (typeof entrypoint !== 'string' || entrypoint.trim() === '') {
    throw new Error('Cannot restart Dominds because the current process entrypoint is unavailable');
  }
  return entrypoint;
}

function buildCurrentProcessRestartArgs(): string[] {
  getCurrentProcessEntrypoint();
  return [...PROCESS_START_EXEC_ARGV, ...PROCESS_START_ARGV.slice(1)];
}

function buildCurrentDomindsCliArgs(): string[] {
  return PROCESS_START_ARGV.slice(2);
}

function getNpxWorkspaceDirAbs(): string | null {
  const entrypoint = getCurrentProcessEntrypoint().replace(/\\/g, '/');
  const marker = '/node_modules/dominds/';
  const markerIndex = entrypoint.indexOf(marker);
  if (markerIndex < 0) return null;
  const nodeModulesPrefix = entrypoint.slice(0, markerIndex);
  const nodeModulesSuffix = '/node_modules';
  if (!nodeModulesPrefix.endsWith(nodeModulesSuffix)) return null;
  const workspaceDir = nodeModulesPrefix.slice(0, -nodeModulesSuffix.length);
  if (workspaceDir.trim() === '') return null;
  return path.resolve(PROCESS_START_CWD, workspaceDir);
}

function parseNpxDomindsPackageSpec(spec: string): NpxDomindsSpec | null {
  if (spec === 'dominds@latest') return { kind: 'latest' };
  if (spec === 'dominds') return { kind: 'versionless' };
  if (spec.startsWith('dominds@')) return { kind: 'fixed', spec };
  return null;
}

async function readNpxDomindsSpec(): Promise<NpxDomindsSpec | null> {
  const workspaceDir = getNpxWorkspaceDirAbs();
  if (workspaceDir === null) return null;
  const packageJsonPath = path.join(workspaceDir, 'package.json');
  const raw = await fsPromises.readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`Invalid npx package metadata at ${packageJsonPath}`);
  const npxValue = parsed['_npx'];
  const packagesValue = isRecord(npxValue) ? npxValue['packages'] : undefined;
  if (!Array.isArray(packagesValue)) return null;
  for (const packageSpec of packagesValue) {
    if (typeof packageSpec !== 'string') continue;
    const parsedSpec = parseNpxDomindsPackageSpec(packageSpec.trim());
    if (parsedSpec !== null) return parsedSpec;
  }
  return null;
}

async function buildNpxLatestRestartLaunchSpec(): Promise<RestartLaunchSpec> {
  const npm = await resolveNpmCommandSpec();
  return {
    command: npm.command,
    args: [...npm.args, 'exec', '-y', '--', 'dominds@latest', ...buildCurrentDomindsCliArgs()],
  };
}

function buildCurrentProcessRestartLaunchSpec(): RestartLaunchSpec {
  return {
    command: process.execPath,
    args: buildCurrentProcessRestartArgs(),
  };
}

function truncateCommandOutput(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length <= COMMAND_OUTPUT_LOG_LIMIT) return raw;
  return `${raw.slice(0, COMMAND_OUTPUT_LOG_LIMIT)}...[truncated ${raw.length - COMMAND_OUTPUT_LOG_LIMIT} chars]`;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getEnvValue(env: NodeJS.ProcessEnv, upperKey: string, lowerKey: string): string | null {
  const upperValue = env[upperKey];
  if (typeof upperValue === 'string' && upperValue.trim() !== '') return upperValue;
  const lowerValue = env[lowerKey];
  if (typeof lowerValue === 'string' && lowerValue.trim() !== '') return lowerValue;
  return null;
}

function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username !== '') parsed.username = '***';
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return proxyUrl.replace(/\/\/[^@/]+@/g, '//***@');
  }
}

function buildPackageManagerCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const httpProxy = getEnvValue(env, 'HTTP_PROXY', 'http_proxy');
  const httpsProxy = getEnvValue(env, 'HTTPS_PROXY', 'https_proxy');
  const noProxy = getEnvValue(env, 'NO_PROXY', 'no_proxy');

  if (httpProxy !== null) {
    env.HTTP_PROXY = httpProxy;
    env.http_proxy = httpProxy;
    env.npm_config_proxy = httpProxy;
  }
  if (httpsProxy !== null) {
    env.HTTPS_PROXY = httpsProxy;
    env.https_proxy = httpsProxy;
    env.npm_config_https_proxy = httpsProxy;
  }
  if (noProxy !== null) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
    env.npm_config_noproxy = noProxy;
  }

  env.npm_config_progress = 'false';
  env.npm_config_update_notifier = 'false';
  env.NO_UPDATE_NOTIFIER = '1';

  return env;
}

function summarizeNpmProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_noproxy',
  ]) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    summary[key] = PROXY_URL_ENV_KEYS.has(key) ? redactProxyUrl(value) : value;
  }
  return summary;
}

async function resolveNpmCommandSpec(): Promise<PackageManagerCommandSpec> {
  const nodeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.join(nodeDir, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
        ];

  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate);
      return {
        command: process.execPath,
        args: [candidate],
        display: process.execPath + ' ' + candidate,
      };
    } catch {
      continue;
    }
  }

  if (process.platform === 'win32') {
    throw new Error(
      'Cannot find bundled npm CLI at ' +
        candidates.join(', ') +
        '. Dominds self-update avoids npm.cmd so the Windows console title is not hijacked.',
    );
  }

  return { command: 'npm', args: [], display: 'npm' };
}

async function resolveCorepackPnpmCommandSpec(): Promise<PackageManagerCommandSpec | null> {
  const nodeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js')]
      : [
          path.join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
          path.join(nodeDir, '..', 'share', 'nodejs', 'corepack', 'dist', 'corepack.js'),
        ];

  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate);
      return {
        command: process.execPath,
        args: [candidate, 'pnpm'],
        display: process.execPath + ' ' + candidate + ' pnpm',
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function resolvePnpmCommandSpec(): Promise<PackageManagerCommandSpec> {
  const userAgent = process.env.npm_config_user_agent;
  if (typeof userAgent === 'string' && userAgent.startsWith('pnpm/')) {
    const npmExecpath = process.env.npm_execpath;
    if (typeof npmExecpath === 'string' && npmExecpath.trim() !== '') {
      return {
        command: process.execPath,
        args: [npmExecpath],
        display: process.execPath + ' ' + npmExecpath,
      };
    }
  }

  const corepackPnpm = await resolveCorepackPnpmCommandSpec();
  if (corepackPnpm !== null) return corepackPnpm;

  if (process.platform === 'win32') {
    throw new Error(
      'Cannot resolve pnpm CLI without pnpm npm_execpath or bundled Corepack on Windows',
    );
  }
  return { command: 'pnpm', args: [], display: 'pnpm' };
}

function getStringOrNumberErrorProp(error: unknown, key: string): string | number | null {
  const value = getErrorProp(error, key);
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function getStringErrorProp(error: unknown, key: string): string | null {
  const value = getErrorProp(error, key);
  return typeof value === 'string' ? value : null;
}

function getBooleanErrorProp(error: unknown, key: string): boolean | null {
  const value = getErrorProp(error, key);
  return typeof value === 'boolean' ? value : null;
}

function createCommandFailureError(params: {
  cmd: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  outputExceeded: boolean;
  capturedOutputChars: number;
  maxBuffer: number;
  code: string | number | null;
  signal: string | null;
  killed: boolean | null;
  stdout: string;
  stderr: string;
  proxyEnvSummary: Record<string, string>;
  cause?: unknown;
}): Error {
  const reason = params.timedOut
    ? `Command timed out after ${params.durationMs}ms: ${params.cmd}`
    : params.outputExceeded
      ? `Command exceeded output limit after capturing ${params.capturedOutputChars}/${params.maxBuffer} chars: ${params.cmd}`
      : `Command failed: ${params.cmd}`;
  const error = new Error(reason) as Error & Record<string, unknown>;
  if (params.cause instanceof Error) {
    error.cause = params.cause;
  }
  error.cmd = params.cmd;
  error.code = params.code;
  error.signal = params.signal;
  error.killed = params.killed;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.domindsDurationMs = params.durationMs;
  error.domindsTimeoutMs = params.timeoutMs;
  error.domindsTimedOut = params.timedOut;
  error.domindsOutputExceeded = params.outputExceeded;
  error.domindsCapturedOutputChars = params.capturedOutputChars;
  error.domindsMaxBuffer = params.maxBuffer;
  error.domindsProxyEnvSummary = params.proxyEnvSummary;
  return error;
}

async function runPackageManagerCommand(
  commandSpec: PackageManagerCommandSpec,
  args: readonly string[],
  params: { timeoutMs: number; maxBuffer: number },
): Promise<PackageManagerCommandResult> {
  const env = buildPackageManagerCommandEnv();
  const startedAtMs = Date.now();
  const cmd = [commandSpec.display, ...args].join(' ');
  return await new Promise<PackageManagerCommandResult>((resolve, reject) => {
    const child = spawn(commandSpec.command, [...commandSpec.args, ...args], {
      cwd: PROCESS_START_CWD,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, params.timeoutMs);
    const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputExceeded) return;
      const next = chunk.toString('utf8');
      if (stream === 'stdout') {
        stdout += next;
      } else {
        stderr += next;
      }
      if (stdout.length + stderr.length <= params.maxBuffer) return;
      outputExceeded = true;
      child.kill('SIGTERM');
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      appendOutput('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendOutput('stderr', chunk);
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      finish(() => {
        reject(
          createCommandFailureError({
            cmd,
            durationMs: Date.now() - startedAtMs,
            timeoutMs: params.timeoutMs,
            timedOut,
            outputExceeded,
            capturedOutputChars: stdout.length + stderr.length,
            maxBuffer: params.maxBuffer,
            code: getStringOrNumberErrorProp(error, 'code'),
            signal: getStringErrorProp(error, 'signal'),
            killed: getBooleanErrorProp(error, 'killed'),
            stdout: truncateCommandOutput(stdout),
            stderr: truncateCommandOutput(stderr),
            proxyEnvSummary: summarizeNpmProxyEnv(env),
          }),
        );
      });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          createCommandFailureError({
            cmd,
            durationMs: Date.now() - startedAtMs,
            timeoutMs: params.timeoutMs,
            timedOut,
            outputExceeded,
            capturedOutputChars: stdout.length + stderr.length,
            maxBuffer: params.maxBuffer,
            code: code === null ? null : code,
            signal: signal === null ? null : signal,
            killed: timedOut || child.killed || null,
            stdout: truncateCommandOutput(stdout),
            stderr: truncateCommandOutput(stderr),
            proxyEnvSummary: summarizeNpmProxyEnv(env),
          }),
        );
      });
    });
  });
}

async function runCurrentDomindsVersionProbe(): Promise<DomindsCommandResult> {
  const startedAtMs = Date.now();
  const timeoutMs = 15_000;
  return await new Promise<DomindsCommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, [getCurrentProcessEntrypoint(), '--version'], {
      cwd: PROCESS_START_CWD,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = timedOut
          ? `timed out after ${String(Date.now() - startedAtMs)}ms`
          : `exited with code=${String(code)} signal=${String(signal)}`;
        reject(
          new Error(
            `current Dominds entrypoint --version probe ${detail}; stdout=${truncateCommandOutput(stdout)} stderr=${truncateCommandOutput(stderr)}`,
          ),
        );
      });
    });
  });
}

function getErrorProp(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecordOnly(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function extractCommandFailureDiagnostics(error: unknown): CommandFailureDiagnostics {
  const code = getErrorProp(error, 'code');
  const signal = getErrorProp(error, 'signal');
  const killed = getErrorProp(error, 'killed');
  const cmd = getErrorProp(error, 'cmd');
  const durationMs = getErrorProp(error, 'domindsDurationMs');
  const timeoutMs = getErrorProp(error, 'domindsTimeoutMs');
  const timedOut = getErrorProp(error, 'domindsTimedOut');
  const outputExceeded = getErrorProp(error, 'domindsOutputExceeded');
  const capturedOutputChars = getErrorProp(error, 'domindsCapturedOutputChars');
  const maxBuffer = getErrorProp(error, 'domindsMaxBuffer');
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
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : null,
    timedOut: typeof timedOut === 'boolean' ? timedOut : false,
    outputExceeded: typeof outputExceeded === 'boolean' ? outputExceeded : false,
    capturedOutputChars: typeof capturedOutputChars === 'number' ? capturedOutputChars : null,
    maxBuffer: typeof maxBuffer === 'number' ? maxBuffer : null,
    proxyEnvSummary: stringRecordOnly(getErrorProp(error, 'domindsProxyEnvSummary')),
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
  if (diagnostics.durationMs !== null) {
    lines.push(`durationMs: ${diagnostics.durationMs}`);
  }
  if (diagnostics.timeoutMs !== null) {
    lines.push(`timeoutMs: ${diagnostics.timeoutMs}`);
  }
  if (diagnostics.capturedOutputChars !== null) {
    lines.push(`capturedOutputChars: ${diagnostics.capturedOutputChars}`);
  }
  if (diagnostics.maxBuffer !== null) {
    lines.push(`maxBuffer: ${diagnostics.maxBuffer}`);
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
  for (const [key, value] of Object.entries(diagnostics.proxyEnvSummary)) {
    lines.push(`${key}: ${value}`);
  }

  const lowerMessage = diagnostics.message.toLowerCase();
  if (diagnostics.timedOut) {
    lines.push(
      'hint: npm view exceeded the Dominds latest-version check timeout before producing output',
    );
  } else if (diagnostics.outputExceeded) {
    lines.push('hint: npm produced more output than Dominds expected for this command');
  } else if (
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
  } else if (diagnostics.code === 1 && diagnostics.stderr === '' && diagnostics.stdout === '') {
    lines.push(
      'hint: npm exited without output; check registry access and npm config in the same shell',
    );
  }

  return lines.join('\n');
}

async function queryLatestVersion(): Promise<LatestQueryResult> {
  const checkedAt = formatUnifiedTimestamp(new Date());
  try {
    const { stdout } = await runPackageManagerCommand(
      await resolveNpmCommandSpec(),
      ['view', 'dominds', 'version', '--json'],
      {
        maxBuffer: 1024 * 1024,
        timeoutMs: LATEST_VERSION_CHECK_TIMEOUT_MS,
      },
    );
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
    const errorText = formatCommandFailureForUi(diagnostics);
    log.warn('Dominds latest-version check failed', error, { checkedAt, errorText, diagnostics });
    return {
      kind: 'error',
      errorText,
      checkedAt,
    };
  }
}

async function findRunningDomindsPackageRootAbs(): Promise<string | null> {
  const scriptPath = PROCESS_START_ARGV[1];
  if (typeof scriptPath !== 'string' || scriptPath.trim() === '') return null;
  const scriptPathAbs = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(PROCESS_START_CWD, scriptPath);
  let currentDir = path.dirname(scriptPathAbs);
  for (let depth = 0; depth < 8; depth++) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    try {
      const raw = await fsPromises.readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed) && parsed.name === 'dominds') return currentDir;
    } catch (error: unknown) {
      const code = getStringErrorProp(error, 'code');
      if (code !== 'ENOENT') throw error;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
  return null;
}

async function readPackageVersionFromPackageJson(packageJsonPath: string): Promise<string | null> {
  try {
    const raw = await fsPromises.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.version !== 'string' || parsed.version.trim() === '') {
      throw new Error(`Invalid Dominds package metadata at ${packageJsonPath}`);
    }
    return parsed.version.trim();
  } catch (error: unknown) {
    const code = getStringErrorProp(error, 'code');
    if (code === 'ENOENT') return null;
    throw error;
  }
}

async function readCurrentDomindsPackageRootAbs(): Promise<string> {
  const runningPackageRoot = await findRunningDomindsPackageRootAbs();
  if (runningPackageRoot === null) {
    throw new Error('Cannot find package.json for the current Dominds process entrypoint');
  }
  return runningPackageRoot;
}

async function readCurrentDomindsPackageVersion(): Promise<string> {
  const runningPackageRoot = await readCurrentDomindsPackageRootAbs();
  const packageJsonPath = path.join(runningPackageRoot, 'package.json');
  const version = await readPackageVersionFromPackageJson(packageJsonPath);
  if (version === null) {
    throw new Error(`Cannot read current Dominds package metadata at ${packageJsonPath}`);
  }
  return version;
}

function parsePackageManagerRoot(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const npmRoot = lines[lines.length - 1];
  if (npmRoot === undefined) {
    throw new Error('package manager root -g returned empty stdout');
  }
  return npmRoot;
}

async function readSymlinkTargetAbs(absPath: string): Promise<string | null> {
  try {
    const stat = await fsPromises.lstat(absPath);
    if (!stat.isSymbolicLink()) return null;
    const target = await fsPromises.readlink(absPath);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(absPath), target);
  } catch (error: unknown) {
    const code = getStringErrorProp(error, 'code');
    if (code === 'ENOENT') return null;
    throw error;
  }
}

function isSameOrInsidePath(childAbs: string, parentAbs: string): boolean {
  const childComparable = normalizeComparablePath(path.resolve(childAbs));
  const parentComparable = normalizeComparablePath(path.resolve(parentAbs));
  if (childComparable === parentComparable) return true;
  const relative = path.relative(parentComparable, childComparable);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readGlobalRootAbs(commandSpec: PackageManagerCommandSpec): Promise<string> {
  const rootResult = await runPackageManagerCommand(commandSpec, ['root', '-g'], {
    maxBuffer: 1024 * 1024,
    timeoutMs: 15_000,
  });
  return path.resolve(PROCESS_START_CWD, parsePackageManagerRoot(rootResult.stdout));
}

async function verifyGlobalInstallTargetsCurrentPackage(): Promise<GlobalInstallTargetVerification> {
  let currentPackageRootAbs: string | null = null;
  const checkedTargets: string[] = [];
  try {
    currentPackageRootAbs = await readCurrentDomindsPackageRootAbs();
    const currentComparable = await getComparableRealPath(currentPackageRootAbs);
    const managers: readonly GlobalInstallManager[] = ['npm', 'pnpm'];

    for (const manager of managers) {
      try {
        const commandSpec =
          manager === 'pnpm' ? await resolvePnpmCommandSpec() : await resolveNpmCommandSpec();
        const managerGlobalRootAbs = await readGlobalRootAbs(commandSpec);
        const managerPackageRootAbs = path.join(managerGlobalRootAbs, 'dominds');
        checkedTargets.push(manager + ':' + managerPackageRootAbs);
        const symlinkTargetAbs = await readSymlinkTargetAbs(managerPackageRootAbs);
        if (
          symlinkTargetAbs !== null &&
          !isSameOrInsidePath(symlinkTargetAbs, managerGlobalRootAbs)
        ) {
          checkedTargets.push(manager + ':linked:' + symlinkTargetAbs);
          continue;
        }
        const managerComparable = await getComparableRealPath(managerPackageRootAbs);
        if (currentComparable === managerComparable) {
          return {
            kind: 'ok',
            manager,
            currentPackageRootAbs,
            managerPackageRootAbs,
          };
        }
      } catch (error: unknown) {
        checkedTargets.push(manager + ':error:' + formatErrorForUi(error));
      }
    }

    return {
      kind: 'unsupported',
      currentPackageRootAbs,
      checkedTargets,
      message:
        'Automatic global update is disabled because neither npm nor pnpm global install target safely matches the current Dominds process at ' +
        currentPackageRootAbs +
        '. Checked: ' +
        checkedTargets.join('; ') +
        '.',
    };
  } catch (error: unknown) {
    return {
      kind: 'unsupported',
      currentPackageRootAbs,
      checkedTargets,
      message:
        'Automatic global update is disabled because the global install target could not be verified: ' +
        formatErrorForUi(error),
    };
  }
}

function buildGlobalInstallArgs(manager: GlobalInstallManager): readonly string[] {
  return manager === 'pnpm' ? ['add', '-g', 'dominds@latest'] : ['i', '-g', 'dominds@latest'];
}

async function buildGlobalInstallCommandSpec(
  manager: GlobalInstallManager,
): Promise<PackageManagerCommandSpec> {
  return manager === 'pnpm' ? await resolvePnpmCommandSpec() : await resolveNpmCommandSpec();
}

function parseDomindsVersionProbe(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match =
    /dominds\s+v([^\s]+)/i.exec(combined) ??
    /\bv(\d+(?:\.\d+){1,3}(?:[-+][^\s]+)?)\b/i.exec(combined);
  if (match === null) return null;
  return match[1].trim();
}

function formatErrorForUi(error: unknown): string {
  const diagnostics = extractCommandFailureDiagnostics(error);
  if (diagnostics.cmd !== null || diagnostics.stdout !== '' || diagnostics.stderr !== '') {
    return formatCommandFailureForUi(diagnostics);
  }
  return error instanceof Error ? error.message : String(error);
}

async function verifyInstalledDominds(
  targetVersion: string,
): Promise<InstalledDomindsVerification> {
  let packageVersion: string | null = null;
  let probeVersion: string | null = null;
  try {
    packageVersion = await readCurrentDomindsPackageVersion();
    const probe = await runCurrentDomindsVersionProbe();
    probeVersion = parseDomindsVersionProbe(probe.stdout, probe.stderr);
    if (probeVersion === null) {
      return {
        kind: 'failed',
        message: `Current Dominds entrypoint did not report a parseable version; stdout=${truncateCommandOutput(probe.stdout)} stderr=${truncateCommandOutput(probe.stderr)}`,
        packageVersion,
        probeVersion,
      };
    }

    const packageProbeComparison = compareVersions(packageVersion, probeVersion);
    const versionsMatch =
      packageProbeComparison !== null
        ? packageProbeComparison === 0
        : packageVersion === probeVersion;
    const packageTargetComparison = compareVersions(packageVersion, targetVersion);
    const probeTargetComparison = compareVersions(probeVersion, targetVersion);
    const packageAtLeastTarget =
      packageTargetComparison !== null
        ? packageTargetComparison >= 0
        : packageVersion === targetVersion;
    const probeAtLeastTarget =
      probeTargetComparison !== null ? probeTargetComparison >= 0 : probeVersion === targetVersion;
    if (!versionsMatch || !packageAtLeastTarget || !probeAtLeastTarget) {
      return {
        kind: 'failed',
        message: `Current Dominds entrypoint version verification failed; target=${targetVersion} package=${packageVersion} probe=${probeVersion}`,
        packageVersion,
        probeVersion,
      };
    }

    return { kind: 'ok', packageVersion, probeVersion };
  } catch (error: unknown) {
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
      packageVersion,
      probeVersion,
    };
  }
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
  installFailureObservation = null;
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
  closeWebSocketClients: () => void;
  stopServer: () => Promise<void>;
}): void {
  runtimeConfig = {
    host: params.host,
    port: params.port,
    mode: params.mode,
    closeWebSocketClients: params.closeWebSocketClients,
    stopServer: params.stopServer,
  };
  latestObservation = { kind: 'unknown' };
  restartState = IDLE_RESTART_STATE;
  installFailureObservation = null;
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
      reason: restartState.reason,
      message: restartState.installReport ?? 'Latest Dominds is installed and waiting for restart',
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

  if (installFailureObservation !== null) {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.kind === 'ok' ? latestObservation.latestVersion : null,
      checkedAt: installFailureObservation.failedAt,
      mode: cfg.mode,
      runKind,
      action: latestObservation.kind === 'ok' ? 'install' : 'none',
      busy: 'idle',
      reason: 'install_failed',
      message: installFailureObservation.errorText,
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

  if (runKind === 'npx') {
    const npxSpec = await readNpxDomindsSpec();
    if (npxSpec?.kind === 'latest') {
      return buildStatus({
        currentVersion: runningVersion,
        installedVersion: runningVersion,
        latestVersion: latestObservation.latestVersion,
        checkedAt: latestObservation.checkedAt,
        mode: cfg.mode,
        runKind,
        action: 'restart',
        busy: 'idle',
        reason: 'restart_required',
        message: 'Restart to relaunch Dominds via npx dominds@latest',
        targetVersion: latestObservation.latestVersion,
      });
    }

    const reason =
      npxSpec?.kind === 'fixed' ? 'npx_fixed_version_unsupported' : 'npx_versionless_unsupported';
    const message =
      npxSpec?.kind === 'fixed'
        ? `A newer Dominds version is available, but this npx session was launched with ${npxSpec.spec}; use dominds@latest to enable automatic restart updates.`
        : 'A newer Dominds version is available, but this npx session was launched without a verified dominds@latest spec; use dominds@latest to enable automatic restart updates.';
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.latestVersion,
      checkedAt: latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason,
      message,
      targetVersion: latestObservation.latestVersion,
    });
  }

  const globalTargetVerification = await verifyGlobalInstallTargetsCurrentPackage();
  if (globalTargetVerification.kind === 'unsupported') {
    return buildStatus({
      currentVersion: runningVersion,
      installedVersion: runningVersion,
      latestVersion: latestObservation.latestVersion,
      checkedAt: latestObservation.checkedAt,
      mode: cfg.mode,
      runKind,
      action: 'none',
      busy: 'idle',
      reason: 'global_install_target_unsupported',
      message: globalTargetVerification.message,
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
  if (runKind !== 'global') {
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
    installFailureObservation = null;
    const runningVersion = getRunningVersion();
    const previouslyKnownLatest = latestObservation.kind === 'ok' ? latestObservation : null;
    const latest = await queryLatestVersion();
    let targetVersion: string;
    if (latest.kind === 'ok') {
      latestObservation = latest;
      targetVersion = latest.latestVersion;
    } else if (previouslyKnownLatest === null) {
      latestObservation = latest;
      throw new Error(latest.errorText);
    } else {
      targetVersion = previouslyKnownLatest.latestVersion;
      log.warn(
        'Dominds install latest-version refresh failed; continuing with previously known update target',
        undefined,
        {
          previousLatestVersion: previouslyKnownLatest.latestVersion,
          previousCheckedAt: previouslyKnownLatest.checkedAt,
          refreshErrorText: latest.errorText,
          refreshCheckedAt: latest.checkedAt,
        },
      );
    }
    const comparison = compareVersions(runningVersion, targetVersion);
    const hasUpdate = comparison !== null ? comparison < 0 : runningVersion !== targetVersion;
    if (!hasUpdate) {
      throw new Error('No installable Dominds update is currently available');
    }
    const globalTargetVerification = await verifyGlobalInstallTargetsCurrentPackage();
    if (globalTargetVerification.kind === 'unsupported') {
      throw new Error(globalTargetVerification.message);
    }
    let installCommandError: unknown = null;
    try {
      await runPackageManagerCommand(
        await buildGlobalInstallCommandSpec(globalTargetVerification.manager),
        buildGlobalInstallArgs(globalTargetVerification.manager),
        {
          maxBuffer: 20 * 1024 * 1024,
          timeoutMs: 10 * 60 * 1000,
        },
      );
    } catch (error: unknown) {
      installCommandError = error;
      log.warn(
        'Dominds install command failed; verifying installed files before reporting failure',
        error,
        {
          currentVersion: runningVersion,
          targetVersion,
        },
      );
    }
    const installedVerification = await verifyInstalledDominds(targetVersion);
    if (installedVerification.kind === 'failed') {
      if (installCommandError !== null) {
        throw new Error(
          `npm install failed and installed Dominds verification failed. npm: ${formatErrorForUi(installCommandError)} verification: ${installedVerification.message}`,
        );
      }
      throw new Error(installedVerification.message);
    }
    if (installCommandError !== null) {
      log.warn(
        'Dominds install command failed but installed files passed verification',
        installCommandError,
        {
          targetVersion,
          packageVersion: installedVerification.packageVersion,
          probeVersion: installedVerification.probeVersion,
        },
      );
    }
    const installReport =
      installCommandError === null
        ? null
        : `Dominds install command reported failure, but the current entrypoint version probe confirmed v${installedVerification.probeVersion}. Restart is available.`;
    restartState = {
      kind: 'restart_required',
      installedVersion: installedVerification.probeVersion,
      installReport,
      reason:
        installCommandError === null
          ? 'restart_required'
          : 'install_verified_after_command_failure',
    };
    installFailureObservation = null;
    return await getDomindsSelfUpdateStatus();
  })()
    .catch((error: unknown) => {
      const latestVersion =
        latestObservation.kind === 'ok' ? latestObservation.latestVersion : null;
      const checkedAt = latestObservation.kind === 'unknown' ? null : latestObservation.checkedAt;
      installFailureObservation = {
        errorText: formatErrorForUi(error),
        failedAt: formatUnifiedTimestamp(new Date()),
      };
      log.error('Dominds version install failed', error, {
        runKind,
        currentVersion: getRunningVersion(),
        latestVersion,
        checkedAt,
      });
      return getDomindsSelfUpdateStatus();
    })
    .finally(() => {
      installPromise = null;
      publishStatusUpdateSoon();
    });

  publishStatusUpdateSoon();
  return await getDomindsSelfUpdateStatus();
}

async function spawnDetachedRestartHelper(params: {
  command: string;
  args: readonly string[];
  cwd: string;
  host: string;
  port: number;
  trace: RestartTraceContext;
}): Promise<number | null> {
  const stdioMode = getRestartHelperStdio();
  const helperEntrypoint = getRestartHelperEntrypoint();
  await fsPromises.access(helperEntrypoint);
  const helperPayload: RestartHelperPayload = {
    command: params.command,
    args: [...params.args],
    cwd: params.cwd,
    host: getRestartPortProbeHost(params.host),
    port: params.port,
    retiringPid: process.pid,
    forceKillAfterMs: RESTART_FORCE_KILL_AFTER_MS,
    probeIntervalMs: RESTART_PORT_PROBE_INTERVAL_MS,
    portReleaseTimeoutMs: RESTART_PORT_RELEASE_TIMEOUT_MS,
    stdioMode,
    traceFile: params.trace.traceFile,
    debugDir: params.trace.debugDir,
  };
  const helper = spawn(process.execPath, [helperEntrypoint, JSON.stringify(helperPayload)], {
    cwd: params.cwd,
    env: process.env,
    detached: stdioMode !== 'inherit',
    stdio: stdioMode,
    windowsHide: stdioMode !== 'inherit',
  });
  const helperPid = typeof helper.pid === 'number' ? helper.pid : null;
  const helperSpawned = new Promise<number | null>((resolve, reject) => {
    helper.once('spawn', () => {
      appendRestartTraceSoon(params.trace, 'parent.helper_spawn_event', {
        helperPid,
      });
      resolve(helperPid);
    });
    helper.once('error', (error: Error) => {
      appendRestartTraceSoon(params.trace, 'parent.helper_error_event', {
        message: error.message,
        stack: error.stack ?? null,
      });
      reject(error);
    });
  });
  helper.once('exit', (code, signal) => {
    appendRestartTraceSoon(params.trace, 'parent.helper_exit_event', {
      code,
      signal,
    });
  });
  if (stdioMode !== 'inherit') {
    helper.unref();
  }
  return await helperSpawned;
}

async function stopAndExitForRestart(): Promise<void> {
  const cfg = assertRuntimeConfig();
  const trace =
    activeRestartTraceFile === null
      ? null
      : { debugDir: path.dirname(activeRestartTraceFile), traceFile: activeRestartTraceFile };
  let stopSettled = false;
  if (trace !== null) {
    await appendRestartTraceBestEffort(trace, 'parent.stop_and_exit.start', {
      host: cfg.host,
      port: cfg.port,
      exitGraceMs: RESTART_EXIT_GRACE_MS,
    });
  }
  const stopPromise = cfg
    .stopServer()
    .then(() => {
      stopSettled = true;
      if (trace !== null) {
        return appendRestartTraceBestEffort(trace, 'parent.stop_server.finish', {
          host: cfg.host,
          port: cfg.port,
        });
      }
      return undefined;
    })
    .catch((error: unknown) => {
      stopSettled = true;
      if (trace !== null) {
        return appendRestartTraceBestEffort(trace, 'parent.stop_server.error', {
          host: cfg.host,
          port: cfg.port,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        }).then(() => {
          log.error('Failed to stop Dominds HTTP server during restart grace window', error, {
            host: cfg.host,
            port: cfg.port,
          });
        });
      }
      log.error('Failed to stop Dominds HTTP server during restart grace window', error, {
        host: cfg.host,
        port: cfg.port,
      });
      return undefined;
    });
  cfg.closeWebSocketClients();
  await delayMs(RESTART_EXIT_GRACE_MS);
  if (!stopSettled) {
    log.warn(
      'Exiting Dominds process before graceful HTTP server stop completed during restart',
      undefined,
      {
        host: cfg.host,
        port: cfg.port,
        graceMs: RESTART_EXIT_GRACE_MS,
      },
    );
  }
  if (trace !== null) {
    if (stopSettled) {
      await stopPromise;
    }
    await appendRestartTraceBestEffort(trace, 'parent.process_exit', {
      host: cfg.host,
      port: cfg.port,
      stopSettled,
      code: 0,
    });
  }
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
    let launchSpec: RestartLaunchSpec;
    const previousRestartRequiredState =
      restartState.kind === 'restart_required' ? restartState : null;

    if (previousRestartRequiredState !== null) {
      launchSpec = buildCurrentProcessRestartLaunchSpec();
    } else if (runKind === 'npx') {
      const npxSpec = await readNpxDomindsSpec();
      if (npxSpec?.kind !== 'latest') {
        throw new Error('Dominds npx restart requires launching Dominds with dominds@latest');
      }
      launchSpec = await buildNpxLatestRestartLaunchSpec();
    } else {
      throw new Error('Dominds restart requires a completed install or a restartable session');
    }

    restartState = { kind: 'restarting', targetVersion: status.targetVersion };
    publishStatusUpdateSoon();
    const restartCwd = process.cwd();
    const trace = buildRestartTraceContext();
    activeRestartTraceFile = trace.traceFile;
    try {
      await appendRestartTraceBestEffort(trace, 'parent.restart_requested', {
        runKind,
        currentVersion: status.currentVersion,
        targetVersion: status.targetVersion,
        launchCommand: launchSpec.command,
        launchArgs: launchSpec.args,
        restartCwd,
        host: cfg.host,
        port: cfg.port,
        traceFile: trace.traceFile,
      });
      const helperPid = await spawnDetachedRestartHelper({
        command: launchSpec.command,
        args: launchSpec.args,
        cwd: restartCwd,
        host: cfg.host,
        port: cfg.port,
        trace,
      });
      await appendRestartTraceBestEffort(trace, 'parent.helper_spawned', {
        helperPid,
        retiringPid: process.pid,
        host: cfg.host,
        port: cfg.port,
      });
      log.info('Dominds restart helper spawned', undefined, {
        helperPid,
        traceFile: trace.traceFile,
      });
      setImmediate(() => {
        void stopAndExitForRestart().catch((error: unknown) => {
          void appendRestartTraceBestEffort(trace, 'parent.stop_and_exit.error', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
          });
          log.error('Failed to stop Dominds server during restart', error);
          restartState = previousRestartRequiredState ?? IDLE_RESTART_STATE;
          activeRestartTraceFile = null;
          publishStatusUpdateSoon();
        });
      });
    } catch (error) {
      await appendRestartTraceBestEffort(trace, 'parent.restart_error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
      restartState = previousRestartRequiredState ?? IDLE_RESTART_STATE;
      activeRestartTraceFile = null;
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
