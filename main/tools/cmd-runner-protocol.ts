import os from 'node:os';
import path from 'node:path';

export const MAX_CMD_RUNNER_OUTPUT_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export type CmdRunnerSpawnSpec = Readonly<{
  command: string;
  args: string[];
  shellLabel: string;
  windowsVerbatimArguments?: boolean;
}>;

export type CmdRunnerInitMessage = Readonly<{
  type: 'init';
  initialCommandLine: string;
  spawnSpec: CmdRunnerSpawnSpec;
  timeoutSeconds: number;
  scrollbackLines: number;
}>;

export type CmdRunnerInitialIpcMessage =
  | Readonly<{
      type: 'completed';
      exitCode: number | null;
      exitSignal: string | null;
      stdout: CmdRunnerStreamSnapshot;
      stderr: CmdRunnerStreamSnapshot;
    }>
  | Readonly<{
      type: 'daemonized';
      daemonPid: number;
      daemonCommandLine: string;
      endpoint: string;
      runnerPid: number;
      processGroupId?: number;
      shell: string;
      startTime: string;
    }>
  | Readonly<{
      type: 'failed';
      errorText: string;
    }>;

export type CmdRunnerRequest =
  | Readonly<{ type: 'ping' }>
  | Readonly<{ type: 'get_status' }>
  | Readonly<{
      type: 'get_output';
      stdout: boolean;
      stderr: boolean;
      waitForNewOutput: boolean;
      timeoutMs?: number;
    }>
  | Readonly<{ type: 'stop'; entirePg: boolean }>;

export type CmdRunnerStreamSnapshot = Readonly<{
  content: string;
  linesScrolledOut: number;
  version: number;
}>;

export type CmdRunnerOutputWaitStatus = 'output' | 'timeout' | 'exited';

export type CmdRunnerStatusPayload = Readonly<{
  daemonPid: number;
  daemonCommandLine: string;
  endpoint: string;
  runnerPid: number;
  processGroupId?: number;
  shell: string;
  startTime: string;
  isRunning: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  stdout: CmdRunnerStreamSnapshot;
  stderr: CmdRunnerStreamSnapshot;
}>;

export type CmdRunnerResponse =
  | (Readonly<{ type: 'pong'; ok: true }> & CmdRunnerStatusPayload)
  | (Readonly<{ type: 'status'; ok: true }> & CmdRunnerStatusPayload)
  | (Readonly<{ type: 'output'; ok: true; waitStatus?: CmdRunnerOutputWaitStatus }> &
      CmdRunnerStatusPayload)
  | (Readonly<{ type: 'stop_result'; ok: true }> & CmdRunnerStatusPayload)
  | Readonly<{
      type: 'error';
      ok: false;
      errorText: string;
      daemonPid?: number;
      daemonCommandLine?: string;
      endpoint?: string;
      runnerPid?: number;
      processGroupId?: number;
      shell?: string;
      startTime?: string;
      isRunning?: boolean;
      exitCode?: number | null;
      exitSignal?: string | null;
      stdout?: CmdRunnerStreamSnapshot;
      stderr?: CmdRunnerStreamSnapshot;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : asString(value);
}

function parseStreamSnapshot(raw: unknown, label: string): CmdRunnerStreamSnapshot {
  if (!isRecord(raw)) {
    throw new Error(`Invalid cmd_runner ${label}: expected object`);
  }
  const content = asString(raw['content']);
  const linesScrolledOut = asNumber(raw['linesScrolledOut']);
  const version = asNumber(raw['version']);
  if (content === null) {
    throw new Error(`Invalid cmd_runner ${label}.content: expected string`);
  }
  if (linesScrolledOut === null) {
    throw new Error(`Invalid cmd_runner ${label}.linesScrolledOut: expected number`);
  }
  if (version === null) {
    throw new Error(`Invalid cmd_runner ${label}.version: expected number`);
  }
  return { content, linesScrolledOut, version };
}

function parseOptionalTimeoutMs(raw: unknown, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = asNumber(raw);
  if (
    value === null ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_CMD_RUNNER_OUTPUT_WAIT_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid cmd_runner ${label}: expected non-negative integer <= ${String(MAX_CMD_RUNNER_OUTPUT_WAIT_TIMEOUT_MS)}`,
    );
  }
  return value;
}

function parseOutputWaitStatus(raw: unknown): CmdRunnerOutputWaitStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'output' || raw === 'timeout' || raw === 'exited') {
    return raw;
  }
  throw new Error(`Invalid cmd_runner output waitStatus: ${String(raw)}`);
}

function parseStatusPayload(raw: Record<string, unknown>): CmdRunnerStatusPayload {
  const daemonPid = asNumber(raw['daemonPid']);
  const daemonCommandLine = asString(raw['daemonCommandLine']);
  const endpoint = asString(raw['endpoint']);
  const runnerPid = asNumber(raw['runnerPid']);
  const shell = asString(raw['shell']);
  const startTime = asString(raw['startTime']);
  const isRunning = asBoolean(raw['isRunning']);
  const exitCode =
    raw['exitCode'] === null
      ? null
      : raw['exitCode'] === undefined
        ? null
        : asNumber(raw['exitCode']);
  const exitSignal = asNullableString(raw['exitSignal']);
  if (daemonPid === null) throw new Error('Invalid cmd_runner payload.daemonPid');
  if (daemonCommandLine === null) throw new Error('Invalid cmd_runner payload.daemonCommandLine');
  if (endpoint === null) throw new Error('Invalid cmd_runner payload.endpoint');
  if (runnerPid === null) throw new Error('Invalid cmd_runner payload.runnerPid');
  if (shell === null) throw new Error('Invalid cmd_runner payload.shell');
  if (startTime === null) throw new Error('Invalid cmd_runner payload.startTime');
  if (isRunning === null) throw new Error('Invalid cmd_runner payload.isRunning');
  if (exitCode === null && raw['exitCode'] !== null && raw['exitCode'] !== undefined) {
    throw new Error('Invalid cmd_runner payload.exitCode');
  }
  if (exitSignal === undefined) {
    throw new Error('Invalid cmd_runner payload.exitSignal');
  }
  const processGroupId =
    raw['processGroupId'] === undefined ? undefined : (asNumber(raw['processGroupId']) ?? null);
  if (processGroupId === null) {
    throw new Error('Invalid cmd_runner payload.processGroupId');
  }
  return {
    daemonPid,
    daemonCommandLine,
    endpoint,
    runnerPid,
    processGroupId,
    shell,
    startTime,
    isRunning,
    exitCode,
    exitSignal,
    stdout: parseStreamSnapshot(raw['stdout'], 'payload.stdout'),
    stderr: parseStreamSnapshot(raw['stderr'], 'payload.stderr'),
  };
}

export function parseCmdRunnerInitMessage(raw: unknown): CmdRunnerInitMessage {
  if (!isRecord(raw)) {
    throw new Error('Invalid cmd_runner init message: expected object');
  }
  if (raw['type'] !== 'init') {
    throw new Error('Invalid cmd_runner init message: expected type=init');
  }
  const initialCommandLine = asString(raw['initialCommandLine']);
  const timeoutSeconds = asNumber(raw['timeoutSeconds']);
  const scrollbackLines = asNumber(raw['scrollbackLines']);
  if (initialCommandLine === null || initialCommandLine.trim() === '') {
    throw new Error('Invalid cmd_runner init message: initialCommandLine required');
  }
  if (timeoutSeconds === null || !Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Invalid cmd_runner init message: timeoutSeconds must be positive integer');
  }
  if (scrollbackLines === null || !Number.isInteger(scrollbackLines) || scrollbackLines <= 0) {
    throw new Error('Invalid cmd_runner init message: scrollbackLines must be positive integer');
  }
  const spawnSpecRaw = raw['spawnSpec'];
  if (!isRecord(spawnSpecRaw)) {
    throw new Error('Invalid cmd_runner init message: spawnSpec required');
  }
  const command = asString(spawnSpecRaw['command']);
  const shellLabel = asString(spawnSpecRaw['shellLabel']);
  const windowsVerbatimArgumentsRaw = spawnSpecRaw['windowsVerbatimArguments'];
  const argsRaw = spawnSpecRaw['args'];
  if (command === null || command.trim() === '') {
    throw new Error('Invalid cmd_runner init message: spawnSpec.command required');
  }
  if (shellLabel === null || shellLabel.trim() === '') {
    throw new Error('Invalid cmd_runner init message: spawnSpec.shellLabel required');
  }
  if (
    windowsVerbatimArgumentsRaw !== undefined &&
    typeof windowsVerbatimArgumentsRaw !== 'boolean'
  ) {
    throw new Error(
      'Invalid cmd_runner init message: spawnSpec.windowsVerbatimArguments must be boolean',
    );
  }
  if (!Array.isArray(argsRaw) || !argsRaw.every((item) => typeof item === 'string')) {
    throw new Error('Invalid cmd_runner init message: spawnSpec.args must be string[]');
  }
  return {
    type: 'init',
    initialCommandLine,
    timeoutSeconds,
    scrollbackLines,
    spawnSpec: {
      command,
      args: [...argsRaw],
      shellLabel,
      ...(windowsVerbatimArgumentsRaw === true ? { windowsVerbatimArguments: true } : {}),
    },
  };
}

export function parseCmdRunnerInitialIpcMessage(raw: unknown): CmdRunnerInitialIpcMessage {
  if (!isRecord(raw)) {
    throw new Error('Invalid cmd_runner IPC message: expected object');
  }
  const type = asString(raw['type']);
  if (type === 'completed') {
    const exitCode =
      raw['exitCode'] === null
        ? null
        : raw['exitCode'] === undefined
          ? null
          : asNumber(raw['exitCode']);
    const exitSignal = asNullableString(raw['exitSignal']);
    if (exitCode === null && raw['exitCode'] !== null && raw['exitCode'] !== undefined) {
      throw new Error('Invalid cmd_runner completed.exitCode');
    }
    if (exitSignal === undefined) {
      throw new Error('Invalid cmd_runner completed.exitSignal');
    }
    return {
      type,
      exitCode,
      exitSignal,
      stdout: parseStreamSnapshot(raw['stdout'], 'completed.stdout'),
      stderr: parseStreamSnapshot(raw['stderr'], 'completed.stderr'),
    };
  }
  if (type === 'daemonized') {
    const daemonPid = asNumber(raw['daemonPid']);
    const daemonCommandLine = asString(raw['daemonCommandLine']);
    const endpoint = asString(raw['endpoint']);
    const runnerPid = asNumber(raw['runnerPid']);
    const shell = asString(raw['shell']);
    const startTime = asString(raw['startTime']);
    const processGroupId =
      raw['processGroupId'] === undefined ? undefined : (asNumber(raw['processGroupId']) ?? null);
    if (daemonPid === null) throw new Error('Invalid cmd_runner daemonized.daemonPid');
    if (daemonCommandLine === null || daemonCommandLine.trim() === '') {
      throw new Error('Invalid cmd_runner daemonized.daemonCommandLine');
    }
    if (endpoint === null || endpoint.trim() === '') {
      throw new Error('Invalid cmd_runner daemonized.endpoint');
    }
    if (runnerPid === null) throw new Error('Invalid cmd_runner daemonized.runnerPid');
    if (shell === null || shell.trim() === '') {
      throw new Error('Invalid cmd_runner daemonized.shell');
    }
    if (startTime === null || startTime.trim() === '') {
      throw new Error('Invalid cmd_runner daemonized.startTime');
    }
    if (processGroupId === null) {
      throw new Error('Invalid cmd_runner daemonized.processGroupId');
    }
    return {
      type,
      daemonPid,
      daemonCommandLine,
      endpoint,
      runnerPid,
      processGroupId,
      shell,
      startTime,
    };
  }
  if (type === 'failed') {
    const errorText = asString(raw['errorText']);
    if (errorText === null || errorText.trim() === '') {
      throw new Error('Invalid cmd_runner failed.errorText');
    }
    return { type, errorText };
  }
  throw new Error(`Invalid cmd_runner IPC message type: ${String(type)}`);
}

export function parseCmdRunnerRequestLine(line: string): CmdRunnerRequest {
  const raw = JSON.parse(line) as unknown;
  if (!isRecord(raw)) {
    throw new Error('Invalid cmd_runner request: expected object');
  }
  const type = asString(raw['type']);
  if (type === 'ping' || type === 'get_status') {
    return { type };
  }
  if (type === 'stop') {
    const entirePg = asBoolean(raw['entirePg']);
    if (entirePg === null) {
      throw new Error('Invalid cmd_runner stop request: entirePg must be boolean');
    }
    return { type, entirePg };
  }
  if (type === 'get_output') {
    const stdout = asBoolean(raw['stdout']);
    const stderr = asBoolean(raw['stderr']);
    const waitForNewOutputRaw = raw['waitForNewOutput'];
    const waitForNewOutput =
      waitForNewOutputRaw === undefined ? false : asBoolean(waitForNewOutputRaw);
    const timeoutMs = parseOptionalTimeoutMs(raw['timeoutMs'], 'get_output.timeoutMs');
    if (stdout === null || stderr === null) {
      throw new Error('Invalid cmd_runner get_output request: stdout/stderr must be boolean');
    }
    if (waitForNewOutput === null) {
      throw new Error('Invalid cmd_runner get_output request: waitForNewOutput must be boolean');
    }
    if (!stdout && !stderr) {
      throw new Error('Invalid cmd_runner get_output request: at least one stream is required');
    }
    if (!waitForNewOutput && timeoutMs !== undefined) {
      throw new Error(
        'Invalid cmd_runner get_output request: timeoutMs requires waitForNewOutput=true',
      );
    }
    return {
      type,
      stdout,
      stderr,
      waitForNewOutput,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  throw new Error(`Invalid cmd_runner request type: ${String(type)}`);
}

export function parseCmdRunnerResponseLine(line: string): CmdRunnerResponse {
  const raw = JSON.parse(line) as unknown;
  if (!isRecord(raw)) {
    throw new Error('Invalid cmd_runner response: expected object');
  }
  const type = asString(raw['type']);
  const ok = asBoolean(raw['ok']);
  if (type === 'error') {
    const errorText = asString(raw['errorText']);
    if (ok !== false) {
      throw new Error('Invalid cmd_runner error response: ok must be false');
    }
    if (errorText === null || errorText.trim() === '') {
      throw new Error('Invalid cmd_runner error response: errorText required');
    }
    return { type, ok: false, errorText };
  }
  if (ok !== true) {
    throw new Error('Invalid cmd_runner response: ok must be true');
  }
  if (type !== 'pong' && type !== 'status' && type !== 'output' && type !== 'stop_result') {
    throw new Error(`Invalid cmd_runner response type: ${String(type)}`);
  }
  if (type === 'output') {
    const waitStatus = parseOutputWaitStatus(raw['waitStatus']);
    return {
      type,
      ok: true,
      ...(waitStatus === undefined ? {} : { waitStatus }),
      ...parseStatusPayload(raw),
    };
  }
  return {
    type,
    ok: true,
    ...parseStatusPayload(raw),
  };
}

export function getCmdRunnerEndpointForDaemonPid(daemonPid: number): string {
  if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
    throw new Error(`Invalid daemon pid for cmd_runner endpoint: ${String(daemonPid)}`);
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dominds-cmd-${String(daemonPid)}`;
  }
  const baseDir =
    process.platform === 'darwin'
      ? os.tmpdir()
      : process.env['XDG_RUNTIME_DIR'] && process.env['XDG_RUNTIME_DIR']?.trim() !== ''
        ? process.env['XDG_RUNTIME_DIR']
        : os.tmpdir();
  return path.join(baseDir, 'dmcmd', `p-${String(daemonPid)}.sock`);
}
