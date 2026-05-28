import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

export type RestartHelperStdioMode = 'inherit' | 'ignore';

export type RestartHelperPayload = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  host: string;
  port: number;
  retiringPid: number;
  forceKillAfterMs: number;
  probeIntervalMs: number;
  portReleaseTimeoutMs: number;
  stdioMode: RestartHelperStdioMode;
  traceFile: string;
  debugDir: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error(`Invalid Dominds restart helper payload: ${key} must be a non-empty string`);
  }
  return candidate;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`Invalid Dominds restart helper payload: ${key} must be a finite number`);
  }
  return candidate;
}

function readPositiveInteger(value: Record<string, unknown>, key: string): number {
  const candidate = readNumber(value, key);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`Invalid Dominds restart helper payload: ${key} must be a positive integer`);
  }
  return candidate;
}

function readPort(value: Record<string, unknown>, key: string): number {
  const candidate = readPositiveInteger(value, key);
  if (candidate > 65535) {
    throw new Error(`Invalid Dominds restart helper payload: ${key} must be <= 65535`);
  }
  return candidate;
}

function parsePayload(raw: string | undefined): RestartHelperPayload {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Missing Dominds restart helper payload');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Invalid Dominds restart helper payload: expected an object');
  }
  const args = parsed['args'];
  if (!isStringArray(args)) {
    throw new Error('Invalid Dominds restart helper payload: args must be a string array');
  }
  const stdioMode = parsed['stdioMode'];
  if (stdioMode !== 'inherit' && stdioMode !== 'ignore') {
    throw new Error('Invalid Dominds restart helper payload: stdioMode must be inherit or ignore');
  }
  return {
    command: readString(parsed, 'command'),
    args,
    cwd: readString(parsed, 'cwd'),
    host: readString(parsed, 'host'),
    port: readPort(parsed, 'port'),
    retiringPid: readPositiveInteger(parsed, 'retiringPid'),
    forceKillAfterMs: readPositiveInteger(parsed, 'forceKillAfterMs'),
    probeIntervalMs: readPositiveInteger(parsed, 'probeIntervalMs'),
    portReleaseTimeoutMs: readPositiveInteger(parsed, 'portReleaseTimeoutMs'),
    stdioMode,
    traceFile: readString(parsed, 'traceFile'),
    debugDir: readString(parsed, 'debugDir'),
  };
}

function trace(
  payload: RestartHelperPayload,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const record = {
    ...details,
    event,
    capturedAt: formatUnifiedTimestamp(new Date()),
    helperPid: process.pid,
    platform: process.platform,
  };
  try {
    fs.mkdirSync(payload.debugDir, { recursive: true });
    fs.appendFileSync(payload.traceFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write Dominds restart helper trace: ${message}`);
  }
}

function isPortBusy(payload: RestartHelperPayload): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: payload.host, port: payload.port });
    let settled = false;
    const finish = (busy: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

function getErrorCode(error: unknown): string {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : '';
}

function assertValidRetiringPid(payload: RestartHelperPayload): void {
  if (!Number.isInteger(payload.retiringPid) || payload.retiringPid <= 0) {
    throw new Error(`Invalid retiring Dominds pid for restart: ${String(payload.retiringPid)}`);
  }
  if (payload.retiringPid === process.pid) {
    throw new Error(`Refusing to kill restart helper pid ${String(process.pid)}`);
  }
}

function isRetiringProcessAlive(payload: RestartHelperPayload): boolean {
  assertValidRetiringPid(payload);
  try {
    process.kill(payload.retiringPid, 0);
    return true;
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForRetiringProcessExit(
  payload: RestartHelperPayload,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRetiringProcessAlive(payload)) return true;
    await delayMs(payload.probeIntervalMs);
  }
  return false;
}

async function waitForPortReleaseUntil(
  payload: RestartHelperPayload,
  deadline: number,
): Promise<boolean> {
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    if (!(await isPortBusy(payload))) {
      consecutiveReady += 1;
      if (consecutiveReady >= 2) return true;
    } else {
      consecutiveReady = 0;
    }
    await delayMs(payload.probeIntervalMs);
  }
  return false;
}

async function runBestEffortKiller(
  payload: RestartHelperPayload,
  command: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve) => {
    trace(payload, 'helper.force_kill.spawn', { command, args });
    const killer = spawn(command, [...args], {
      stdio: payload.stdioMode,
      windowsHide: payload.stdioMode !== 'inherit',
    });
    killer.once('error', (error: Error) => {
      trace(payload, 'helper.force_kill.error', { message: error.message });
      resolve();
    });
    killer.once('exit', (code, signal) => {
      trace(payload, 'helper.force_kill.exit', { code, signal });
      resolve();
    });
  });
}

async function forceKillRetiringProcess(payload: RestartHelperPayload): Promise<void> {
  assertValidRetiringPid(payload);
  try {
    process.kill(payload.retiringPid, 'SIGKILL');
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ESRCH') return;
    if (process.platform !== 'win32') throw error;
  }
  if (process.platform === 'win32') {
    await runBestEffortKiller(payload, 'taskkill.exe', ['/PID', String(payload.retiringPid), '/F']);
  }
}

async function runRestartHelper(payload: RestartHelperPayload): Promise<void> {
  const detached = payload.stdioMode !== 'inherit';
  trace(payload, 'helper.start', {
    command: payload.command,
    args: payload.args,
    cwd: payload.cwd,
    host: payload.host,
    port: payload.port,
    retiringPid: payload.retiringPid,
    detached,
    stdioMode: payload.stdioMode,
    forceKillAfterMs: payload.forceKillAfterMs,
    portReleaseTimeoutMs: payload.portReleaseTimeoutMs,
    probeIntervalMs: payload.probeIntervalMs,
  });

  const forceKillDeadline = Date.now() + payload.forceKillAfterMs;
  trace(payload, 'helper.wait_retiring_process_exit.start', {
    retiringPid: payload.retiringPid,
    timeoutMs: payload.forceKillAfterMs,
  });
  const exitedGracefully = await waitForRetiringProcessExit(payload, payload.forceKillAfterMs);
  trace(payload, 'helper.wait_retiring_process_exit.finish', {
    retiringPid: payload.retiringPid,
    exited: exitedGracefully,
  });

  if (!exitedGracefully) {
    trace(payload, 'helper.force_kill.start', { retiringPid: payload.retiringPid });
    await forceKillRetiringProcess(payload);
    trace(payload, 'helper.force_kill.finish', { retiringPid: payload.retiringPid });
    trace(payload, 'helper.wait_retiring_process_exit_after_kill.start', {
      retiringPid: payload.retiringPid,
      timeoutMs: payload.portReleaseTimeoutMs,
    });
    const exitedAfterKill = await waitForRetiringProcessExit(payload, payload.portReleaseTimeoutMs);
    trace(payload, 'helper.wait_retiring_process_exit_after_kill.finish', {
      retiringPid: payload.retiringPid,
      exited: exitedAfterKill,
    });
    if (!exitedAfterKill) {
      throw new Error(
        `Dominds retiring process is still alive after force-killing pid ${String(payload.retiringPid)}`,
      );
    }
  }

  const portReleaseDeadline = Math.max(
    forceKillDeadline,
    Date.now() + payload.portReleaseTimeoutMs,
  );
  trace(payload, 'helper.wait_port_release.start', {
    host: payload.host,
    port: payload.port,
    deadlineMsFromNow: portReleaseDeadline - Date.now(),
  });
  const portReleased = await waitForPortReleaseUntil(payload, portReleaseDeadline);
  trace(payload, 'helper.wait_port_release.finish', {
    host: payload.host,
    port: payload.port,
    released: portReleased,
  });
  if (!portReleased) {
    throw new Error(
      `Dominds restart port is still busy after retiring pid ${String(payload.retiringPid)} exited; port=${String(payload.host)}:${String(payload.port)}`,
    );
  }

  trace(payload, 'helper.spawn_new_process.start', {
    command: payload.command,
    args: payload.args,
    cwd: payload.cwd,
    detached,
    stdioMode: payload.stdioMode,
  });
  const child = spawn(payload.command, [...payload.args], {
    cwd: payload.cwd,
    env: process.env,
    detached,
    stdio: payload.stdioMode,
    shell: false,
    windowsHide: payload.stdioMode !== 'inherit',
  });
  if (detached) child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error: Error) => {
      trace(payload, 'helper.spawn_new_process.error', {
        command: payload.command,
        args: payload.args,
        cwd: payload.cwd,
        message: error.message,
        stack: error.stack ?? null,
      });
      reject(error);
    });
    child.once('spawn', resolve);
  });
  trace(payload, 'helper.spawn_new_process.finish', { childPid: child.pid ?? null });
  trace(payload, 'helper.exit', { code: 0 });
}

async function main(): Promise<void> {
  let payload: RestartHelperPayload | null = null;
  try {
    payload = parsePayload(process.argv[2]);
    await runRestartHelper(payload);
    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    if (payload !== null) {
      trace(payload, 'helper.error', { message, stack });
    }
    console.error(message);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
