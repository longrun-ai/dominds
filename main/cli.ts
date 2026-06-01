#!/usr/bin/env node

import { spawn, type ChildProcess } from 'child_process';
import fsPromises from 'fs/promises';
import net from 'net';
import path from 'path';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

import { extractGlobalRtwsChdir } from './bootstrap/rtws-cli';
import {
  DOMINDS_SUPERVISOR_RESTART_WEBUI,
  type DomindsSupervisorRestartWebuiMessage,
} from './supervisor-protocol';

const RUNNER_JS_FILENAME = 'cli-runner.js';
const RUNNER_TS_FILENAME = 'cli-runner.ts';
const INITIAL_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30 * 60 * 1_000;
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_PROBE_INTERVAL_MS = 150;
const RESTART_RUNNER_EXIT_GRACE_MS = 30_000;
const RESTART_RUNNER_KILL_GRACE_MS = 5_000;

type ParsedSupervisorArgs = Readonly<{
  cwd: string;
  runnerArgv: readonly string[];
}>;

type RunnerExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type StopState = {
  stopping: boolean;
};

type CommandSpec = Readonly<{
  command: string;
  args: readonly string[];
}>;

type RunnerMessageParseResult =
  | Readonly<{ kind: 'ignore' }>
  | Readonly<{ kind: 'invalid'; reason: string; traceFile: string | null; debugDir: string | null }>
  | Readonly<{ kind: 'restart'; message: DomindsSupervisorRestartWebuiMessage }>;

function getDefaultRunnerCommandSpec(): CommandSpec {
  if (__filename.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [
        require.resolve('tsx/cli'),
        '--tsconfig',
        path.resolve(__dirname, 'tsconfig.dev.json'),
        path.resolve(__dirname, RUNNER_TS_FILENAME),
      ],
    };
  }
  return { command: process.execPath, args: [path.resolve(__dirname, RUNNER_JS_FILENAME)] };
}

function isLongRunningCommand(argv: readonly string[]): boolean {
  return argv.length === 0 || argv[0] === 'webui';
}

function isDevelopmentMode(argv: readonly string[]): boolean {
  if (process.env.NODE_ENV === 'dev') return true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') return argv[i + 1] === 'dev';
    if (arg === '--mode=dev') return true;
  }
  return false;
}

function parseSupervisorArgs(argv: readonly string[]): ParsedSupervisorArgs {
  const launchCwd = process.cwd();
  const parsed = extractGlobalRtwsChdir({ argv, baseCwd: launchCwd });
  return {
    cwd: parsed.chdir ?? launchCwd,
    runnerArgv: parsed.argv,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRestartStrategy(
  value: unknown,
): value is DomindsSupervisorRestartWebuiMessage['restartStrategy'] {
  return value === 'current_entrypoint' || value === 'npx_latest';
}

function parseRunnerMessage(message: unknown): RunnerMessageParseResult {
  if (!isRecord(message)) return { kind: 'ignore' };
  if (message['type'] !== DOMINDS_SUPERVISOR_RESTART_WEBUI) return { kind: 'ignore' };
  const cwd = message['cwd'];
  const host = message['host'];
  const port = message['port'];
  const traceFile = message['traceFile'];
  const debugDir = message['debugDir'];
  const currentVersion = message['currentVersion'];
  const targetVersion = message['targetVersion'];
  const restartStrategy = message['restartStrategy'];
  const invalid = (reason: string): RunnerMessageParseResult => ({
    kind: 'invalid',
    reason,
    traceFile: typeof traceFile === 'string' ? traceFile : null,
    debugDir: typeof debugDir === 'string' ? debugDir : null,
  });
  if (typeof cwd !== 'string') return invalid('cwd must be a string');
  if (typeof host !== 'string') return invalid('host must be a string');
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return invalid('port must be an integer in 1..65535');
  }
  if (typeof traceFile !== 'string') return invalid('traceFile must be a string');
  if (typeof debugDir !== 'string') return invalid('debugDir must be a string');
  if (typeof currentVersion !== 'string') return invalid('currentVersion must be a string');
  if (targetVersion !== null && typeof targetVersion !== 'string') {
    return invalid('targetVersion must be a string or null');
  }
  if (!isRestartStrategy(restartStrategy)) {
    return invalid('restartStrategy must be current_entrypoint or npx_latest');
  }
  return {
    kind: 'restart',
    message: {
      type: DOMINDS_SUPERVISOR_RESTART_WEBUI,
      cwd,
      host,
      port,
      traceFile,
      debugDir,
      currentVersion,
      targetVersion,
      restartStrategy,
    },
  };
}

async function appendSupervisorTrace(
  message: DomindsSupervisorRestartWebuiMessage,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const record = {
    ...details,
    event,
    capturedAt: formatUnifiedTimestamp(new Date()),
    supervisorPid: process.pid,
    platform: process.platform,
  };
  await fsPromises.mkdir(message.debugDir, { recursive: true });
  await fsPromises.appendFile(message.traceFile, `${JSON.stringify(record)}\n`, 'utf8');
}

function appendSupervisorTraceSoon(
  message: DomindsSupervisorRestartWebuiMessage,
  event: string,
  details: Record<string, unknown> = {},
): void {
  void appendSupervisorTrace(message, event, details).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write Dominds supervisor trace: ${text}`);
  });
}

async function appendSupervisorTraceBestEffort(
  message: DomindsSupervisorRestartWebuiMessage,
  event: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendSupervisorTrace(message, event, details);
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write Dominds supervisor trace: ${text}`);
  }
}

function appendInvalidSupervisorTraceSoon(
  parsed: Extract<RunnerMessageParseResult, { kind: 'invalid' }>,
  event = 'supervisor.invalid_restart_message',
  details: Record<string, unknown> = {},
): void {
  if (parsed.traceFile === null || parsed.debugDir === null) return;
  const message: DomindsSupervisorRestartWebuiMessage = {
    type: DOMINDS_SUPERVISOR_RESTART_WEBUI,
    cwd: process.cwd(),
    host: 'unknown',
    port: 1,
    traceFile: parsed.traceFile,
    debugDir: parsed.debugDir,
    currentVersion: 'unknown',
    targetVersion: null,
    restartStrategy: 'current_entrypoint',
  };
  appendSupervisorTraceSoon(message, event, {
    ...details,
    reason: parsed.reason,
  });
}

async function delayUnlessStopping(ms: number, stopState: StopState): Promise<void> {
  if (stopState.stopping) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const poll = setInterval(() => {
      if (!stopState.stopping) return;
      finish();
    }, 100);
  });
}

function getPortProbeHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function isPortBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
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

async function waitForPortRelease(
  params: Readonly<{ host: string; port: number; stopState: StopState }>,
): Promise<boolean> {
  const probeHost = getPortProbeHost(params.host);
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  let consecutiveReady = 0;
  while (!params.stopState.stopping && Date.now() < deadline) {
    if (!(await isPortBusy(probeHost, params.port))) {
      consecutiveReady += 1;
      if (consecutiveReady >= 2) return true;
    } else {
      consecutiveReady = 0;
    }
    await delayUnlessStopping(PORT_PROBE_INTERVAL_MS, params.stopState);
  }
  return false;
}

async function resolveNpmCommandSpec(): Promise<CommandSpec> {
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
      return { command: process.execPath, args: [candidate] };
    } catch {
      continue;
    }
  }

  if (process.platform === 'win32') {
    throw new Error(`Cannot find bundled npm CLI at ${candidates.join(', ')}`);
  }

  return { command: 'npm', args: [] };
}

async function captureCommandStdout(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `Command failed while resolving dominds@latest runner (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function resolveNpxLatestRunnerEntrypoint(): Promise<string> {
  const npm = await resolveNpmCommandSpec();
  const packageJsonPath = (
    await captureCommandStdout(npm.command, [
      ...npm.args,
      'exec',
      '-y',
      '--package',
      'dominds@latest',
      '--',
      process.execPath,
      '-e',
      [
        "const fs=require('fs');",
        "const path=require('path');",
        "for (const dir of (process.env.PATH||'').split(path.delimiter)) {",
        "  if (path.basename(dir) !== '.bin') continue;",
        "  const candidate=path.join(path.dirname(dir),'dominds','package.json');",
        '  if (fs.existsSync(candidate)) {',
        '    process.stdout.write(fs.realpathSync(candidate));',
        '    process.exit(0);',
        '  }',
        '}',
        "process.stderr.write('Cannot find dominds package in npm exec PATH');",
        'process.exit(1);',
      ].join(' '),
    ])
  ).trim();
  if (packageJsonPath === '') {
    throw new Error('npm exec dominds@latest did not return a package path');
  }
  const packageRoot = path.dirname(packageJsonPath);
  const runnerEntrypoint = path.join(packageRoot, 'dist', RUNNER_JS_FILENAME);
  await fsPromises.access(runnerEntrypoint);
  return runnerEntrypoint;
}

function spawnRunner(
  params: Readonly<{ cwd: string; argv: readonly string[]; commandSpec: CommandSpec }>,
): ChildProcess {
  return spawn(params.commandSpec.command, [...params.commandSpec.args, ...params.argv], {
    cwd: params.cwd,
    env: {
      ...process.env,
      DOMINDS_SUPERVISOR_PID: String(process.pid),
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: false,
  });
}

function isRunningChild(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function runOneShot(params: ParsedSupervisorArgs): Promise<number> {
  const commandSpec = getDefaultRunnerCommandSpec();
  const child = spawn(commandSpec.command, [...commandSpec.args, ...params.runnerArgv], {
    cwd: params.cwd,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  return await new Promise<number>((resolve) => {
    child.once('error', (error: Error) => {
      console.error(`Failed to start dominds-runner: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        console.error(`dominds-runner terminated by signal: ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function runDevelopmentRunner(params: ParsedSupervisorArgs): Promise<number> {
  try {
    process.chdir(params.cwd);
    const { main: runnerMain } = await import('./cli-runner.js');
    await runnerMain(params.runnerArgv);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dominds development runner failed: ${message}`);
    return 1;
  }
}

async function runSupervised(params: ParsedSupervisorArgs): Promise<number> {
  let backoffMs = INITIAL_RESTART_BACKOFF_MS;
  const stopState: StopState = { stopping: false };
  let activeChild: ChildProcess | null = null;
  const restartState: { pending: DomindsSupervisorRestartWebuiMessage | null } = {
    pending: null,
  };
  const invalidRestartState: { pending: string | null } = { pending: null };
  let runnerCommandSpec = getDefaultRunnerCommandSpec();

  const stopFromSignal = (signal: NodeJS.Signals): void => {
    if (stopState.stopping) return;
    stopState.stopping = true;
    const child = activeChild;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };

  process.once('SIGINT', stopFromSignal);
  process.once('SIGTERM', stopFromSignal);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', stopFromSignal);
  }

  while (true) {
    let restartExitTimer: ReturnType<typeof setTimeout> | null = null;
    let restartKillTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRestartExitEnforcement = (): void => {
      if (restartExitTimer !== null) {
        clearTimeout(restartExitTimer);
        restartExitTimer = null;
      }
      if (restartKillTimer !== null) {
        clearTimeout(restartKillTimer);
        restartKillTimer = null;
      }
    };
    const scheduleRestartExitEnforcement = (
      child: ChildProcess,
      message: DomindsSupervisorRestartWebuiMessage,
    ): void => {
      clearRestartExitEnforcement();
      restartExitTimer = setTimeout(() => {
        if (!isRunningChild(child)) return;
        appendSupervisorTraceSoon(message, 'supervisor.restart_runner_exit_timeout', {
          runnerPid: child.pid ?? null,
          graceMs: RESTART_RUNNER_EXIT_GRACE_MS,
        });
        console.error(
          `dominds-runner did not exit within ${String(RESTART_RUNNER_EXIT_GRACE_MS)}ms after restart request; sending SIGTERM`,
        );
        child.kill('SIGTERM');
        restartKillTimer = setTimeout(() => {
          if (!isRunningChild(child)) return;
          appendSupervisorTraceSoon(message, 'supervisor.restart_runner_kill_timeout', {
            runnerPid: child.pid ?? null,
            graceMs: RESTART_RUNNER_KILL_GRACE_MS,
          });
          console.error(
            `dominds-runner still did not exit after SIGTERM; sending SIGKILL before restart`,
          );
          child.kill('SIGKILL');
        }, RESTART_RUNNER_KILL_GRACE_MS);
      }, RESTART_RUNNER_EXIT_GRACE_MS);
    };
    const scheduleInvalidRestartExitEnforcement = (
      child: ChildProcess,
      parsed: Extract<RunnerMessageParseResult, { kind: 'invalid' }>,
    ): void => {
      clearRestartExitEnforcement();
      restartKillTimer = setTimeout(() => {
        if (!isRunningChild(child)) return;
        appendInvalidSupervisorTraceSoon(parsed, 'supervisor.invalid_restart_runner_kill_timeout', {
          runnerPid: child.pid ?? null,
          graceMs: RESTART_RUNNER_KILL_GRACE_MS,
        });
        console.error(`dominds-runner did not exit after invalid restart message; sending SIGKILL`);
        child.kill('SIGKILL');
      }, RESTART_RUNNER_KILL_GRACE_MS);
    };
    const child = spawnRunner({
      cwd: params.cwd,
      argv: params.runnerArgv,
      commandSpec: runnerCommandSpec,
    });
    activeChild = child;

    const exit = await new Promise<RunnerExit>((resolve) => {
      child.once('error', (error: Error) => {
        console.error(`Failed to start dominds-runner: ${error.message}`);
        resolve({ code: 1, signal: null });
      });
      child.on('message', (raw: unknown) => {
        const parsed = parseRunnerMessage(raw);
        if (parsed.kind === 'ignore') return;
        if (parsed.kind === 'invalid') {
          if (invalidRestartState.pending !== null) return;
          console.error(`Invalid dominds-runner restart message: ${parsed.reason}`);
          invalidRestartState.pending = parsed.reason;
          appendInvalidSupervisorTraceSoon(parsed);
          child.kill('SIGTERM');
          scheduleInvalidRestartExitEnforcement(child, parsed);
          return;
        }
        const { message } = parsed;
        restartState.pending = message;
        appendSupervisorTraceSoon(message, 'supervisor.restart_requested', {
          runnerPid: child.pid ?? null,
          cwd: message.cwd,
          host: message.host,
          port: message.port,
          restartStrategy: message.restartStrategy,
        });
        scheduleRestartExitEnforcement(child, message);
      });
      child.once('exit', (code, signal) => {
        clearRestartExitEnforcement();
        resolve({ code, signal });
      });
    });

    activeChild = null;

    if (stopState.stopping) {
      return exit.signal === null ? (exit.code ?? 0) : 1;
    }

    if (invalidRestartState.pending !== null) {
      console.error(
        `dominds supervisor stopped after invalid restart message: ${invalidRestartState.pending}`,
      );
      return 1;
    }

    if (restartState.pending !== null) {
      const restart = restartState.pending;
      restartState.pending = null;
      while (true) {
        await appendSupervisorTraceBestEffort(restart, 'supervisor.wait_port_release.start', {
          host: restart.host,
          port: restart.port,
          timeoutMs: PORT_RELEASE_TIMEOUT_MS,
        });
        const released = await waitForPortRelease({
          host: restart.host,
          port: restart.port,
          stopState,
        });
        await appendSupervisorTraceBestEffort(restart, 'supervisor.wait_port_release.finish', {
          host: restart.host,
          port: restart.port,
          released,
        });
        if (stopState.stopping) return 0;
        if (released) break;
        await appendSupervisorTraceBestEffort(restart, 'supervisor.restart_blocked_port_busy', {
          host: restart.host,
          port: restart.port,
          retryDelayMs: backoffMs,
        });
        console.error(
          `Dominds restart is waiting because port ${restart.host}:${String(restart.port)} is still busy; retrying in ${String(backoffMs)}ms`,
        );
        await delayUnlessStopping(backoffMs, stopState);
        if (stopState.stopping) return 0;
        backoffMs = Math.min(backoffMs * 2, MAX_RESTART_BACKOFF_MS);
      }
      if (restart.restartStrategy === 'npx_latest') {
        while (true) {
          try {
            const runnerEntrypoint = await resolveNpxLatestRunnerEntrypoint();
            runnerCommandSpec = { command: process.execPath, args: [runnerEntrypoint] };
            await appendSupervisorTraceBestEffort(
              restart,
              'supervisor.npx_latest_runner_resolved',
              {
                runnerEntrypoint,
              },
            );
            break;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            await appendSupervisorTraceBestEffort(restart, 'supervisor.npx_latest_runner_error', {
              message,
              retryDelayMs: backoffMs,
            });
            console.error(
              `Dominds restart could not resolve dominds@latest runner: ${message}; retrying in ${String(backoffMs)}ms`,
            );
            await delayUnlessStopping(backoffMs, stopState);
            if (stopState.stopping) return 0;
            backoffMs = Math.min(backoffMs * 2, MAX_RESTART_BACKOFF_MS);
          }
        }
      } else {
        runnerCommandSpec = getDefaultRunnerCommandSpec();
      }
      backoffMs = INITIAL_RESTART_BACKOFF_MS;
      continue;
    }

    console.error(
      `dominds-runner exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)}); restarting in ${String(backoffMs)}ms`,
    );
    await delayUnlessStopping(backoffMs, stopState);
    if (stopState.stopping) return 0;
    backoffMs = Math.min(backoffMs * 2, MAX_RESTART_BACKOFF_MS);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedSupervisorArgs;
  try {
    parsed = parseSupervisorArgs(argv);
    const stat = await fsPromises.stat(parsed.cwd);
    if (!stat.isDirectory()) {
      throw new Error(`rtws path is not a directory: ${parsed.cwd}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
    return;
  }

  if (isLongRunningCommand(parsed.runnerArgv) && isDevelopmentMode(parsed.runnerArgv)) {
    const exitCode = await runDevelopmentRunner(parsed);
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const exitCode = isLongRunningCommand(parsed.runnerArgv)
    ? await runSupervised(parsed)
    : await runOneShot(parsed);
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unhandled dominds supervisor error: ${message}`);
    process.exit(1);
  });
}
