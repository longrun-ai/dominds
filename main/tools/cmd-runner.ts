import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getCmdRunnerEndpointForDaemonPid,
  parseCmdRunnerInitMessage,
  parseCmdRunnerRequestLine,
  type CmdRunnerInitialIpcMessage,
  type CmdRunnerRequest,
  type CmdRunnerResponse,
  type CmdRunnerStatusPayload,
  type CmdRunnerStreamSnapshot,
} from './cmd-runner-protocol';

const execFileAsync = promisify(execFile);

class ScrollingBuffer {
  private lines: string[] = [];
  private linesScrolledOut = 0;

  constructor(private readonly maxLines: number) {}

  addText(text: string): void {
    const newLines = text.split('\n');
    if (newLines[newLines.length - 1] === '') {
      newLines.pop();
    }
    for (const line of newLines) {
      this.lines.push(line);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
        this.linesScrolledOut += 1;
      }
    }
  }

  snapshot(): CmdRunnerStreamSnapshot {
    return {
      content: this.lines.join('\n'),
      linesScrolledOut: this.linesScrolledOut,
    };
  }
}

type RunnerState = {
  endpoint: string;
  daemonPid: number;
  daemonCommandLine: string | null;
  processGroupId?: number;
  shell: string;
  startTime: string;
  isRunning: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  stdout: ScrollingBuffer;
  stderr: ScrollingBuffer;
};

function sendIpc(msg: CmdRunnerInitialIpcMessage): void {
  if (typeof process.send !== 'function') {
    throw new Error('cmd_runner must be launched with an IPC channel');
  }
  process.send(msg);
}

async function flushIpc(msg: CmdRunnerInitialIpcMessage): Promise<void> {
  if (typeof process.send !== 'function') {
    throw new Error('cmd_runner must be launched with an IPC channel');
  }
  await new Promise<void>((resolve, reject) => {
    process.send?.(msg, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', command],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const trimmed = stdout.trim();
      return trimmed === '' ? undefined : trimmed;
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

function buildStatusPayload(state: RunnerState): CmdRunnerStatusPayload {
  const daemonCommandLine = state.daemonCommandLine;
  if (daemonCommandLine === null) {
    throw new Error('cmd_runner invariant violation: daemonCommandLine unavailable');
  }
  return {
    daemonPid: state.daemonPid,
    daemonCommandLine,
    endpoint: state.endpoint,
    runnerPid: process.pid,
    processGroupId: state.processGroupId,
    shell: state.shell,
    startTime: state.startTime,
    isRunning: state.isRunning,
    exitCode: state.exitCode,
    exitSignal: state.exitSignal,
    stdout: state.stdout.snapshot(),
    stderr: state.stderr.snapshot(),
  };
}

async function ensureSocketParentDir(endpoint: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const dir = path.dirname(endpoint);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Best effort only.
  }
  try {
    await fs.unlink(endpoint);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function writeSocketResponse(socket: net.Socket, response: CmdRunnerResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function main(): Promise<void> {
  const initMessage = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('cmd_runner timed out waiting for init message'));
    }, 30_000);
    process.once('message', (raw: unknown) => {
      clearTimeout(timeout);
      resolve(raw);
    });
  });
  const init = parseCmdRunnerInitMessage(initMessage);

  const childProcess: ChildProcess = spawn(init.spawnSpec.command, init.spawnSpec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const daemonPid = childProcess.pid;
  if (typeof daemonPid !== 'number') {
    throw new Error('cmd_runner failed to spawn daemon command: missing pid');
  }

  const endpoint = getCmdRunnerEndpointForDaemonPid(daemonPid);
  await ensureSocketParentDir(endpoint);

  const state: RunnerState = {
    endpoint,
    daemonPid,
    daemonCommandLine: null,
    processGroupId: process.platform === 'win32' ? undefined : process.pid,
    shell: init.spawnSpec.shellLabel,
    startTime: formatUnifiedTimestamp(new Date()),
    isRunning: true,
    exitCode: null,
    exitSignal: null,
    stdout: new ScrollingBuffer(init.scrollbackLines),
    stderr: new ScrollingBuffer(init.scrollbackLines),
  };

  let server: net.Server | undefined;
  let closeRequested = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const closeServerAndExit = (code: number): void => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    const exit = () => {
      setImmediate(() => {
        process.exit(code);
      });
    };
    const cleanupEndpoint = () => {
      if (process.platform !== 'win32') {
        void fs.unlink(endpoint).catch(() => {
          // Best effort only.
        });
      }
    };
    if (!server) {
      cleanupEndpoint();
      exit();
      return;
    }
    try {
      server.close(() => {
        cleanupEndpoint();
        exit();
      });
    } catch (error: unknown) {
      const codeValue =
        typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      if (codeValue !== 'ERR_SERVER_NOT_RUNNING') {
        throw error;
      }
      cleanupEndpoint();
      exit();
    }
  };

  childProcess.once('close', (code, signal) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    state.isRunning = false;
    state.exitCode = code;
    state.exitSignal = signal;
    void (async () => {
      if (state.daemonCommandLine === null) {
        await flushIpc({
          type: 'completed',
          exitCode: code,
          exitSignal: signal,
          stdout: state.stdout.snapshot(),
          stderr: state.stderr.snapshot(),
        });
      }
      closeServerAndExit(0);
    })().catch(() => {
      closeServerAndExit(0);
    });
  });

  childProcess.once('error', (error) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    void flushIpc({
      type: 'failed',
      errorText: error.message,
    })
      .catch(() => undefined)
      .finally(() => {
        closeServerAndExit(1);
      });
  });

  childProcess.stdout?.on('data', (data: Buffer) => {
    state.stdout.addText(data.toString());
  });
  childProcess.stderr?.on('data', (data: Buffer) => {
    state.stderr.addText(data.toString());
  });

  server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = '';
      void (async () => {
        try {
          const request = parseCmdRunnerRequestLine(line);
          if (request.type === 'ping') {
            writeSocketResponse(socket, {
              type: 'pong',
              ok: true,
              ...buildStatusPayload(state),
            });
            return;
          }
          if (request.type === 'get_status') {
            writeSocketResponse(socket, {
              type: 'status',
              ok: true,
              ...buildStatusPayload(state),
            });
            return;
          }
          if (request.type === 'get_output') {
            const payload = buildStatusPayload(state);
            writeSocketResponse(socket, {
              type: 'output',
              ok: true,
              ...payload,
              stdout: request.stdout ? payload.stdout : { content: '', linesScrolledOut: 0 },
              stderr: request.stderr ? payload.stderr : { content: '', linesScrolledOut: 0 },
            });
            return;
          }
          await handleStopRequest(request, state, childProcess);
          writeSocketResponse(socket, {
            type: 'stop_result',
            ok: true,
            ...buildStatusPayload(state),
          });
        } catch (error: unknown) {
          writeSocketResponse(socket, {
            type: 'error',
            ok: false,
            errorText: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });

  timeoutHandle = setTimeout(() => {
    void (async () => {
      const daemonCommandLine = await readProcessCommandLine(daemonPid);
      if (!state.isRunning) {
        return;
      }
      if (daemonCommandLine === undefined || daemonCommandLine.trim() === '') {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {
          // Best effort only.
        }
        if (!state.isRunning) {
          return;
        }
        sendIpc({
          type: 'failed',
          errorText: `failed to capture daemon command line from OS for pid ${String(daemonPid)}`,
        });
        return;
      }
      if (!state.isRunning) {
        return;
      }
      state.daemonCommandLine = daemonCommandLine;
      sendIpc({
        type: 'daemonized',
        daemonPid,
        daemonCommandLine,
        endpoint,
        runnerPid: process.pid,
        processGroupId: state.processGroupId,
        shell: state.shell,
        startTime: state.startTime,
      });
    })().catch((error: unknown) => {
      sendIpc({
        type: 'failed',
        errorText: error instanceof Error ? error.message : String(error),
      });
    });
  }, init.timeoutSeconds * 1000);
}

async function handleStopRequest(
  request: CmdRunnerRequest,
  state: RunnerState,
  childProcess: ChildProcess,
): Promise<void> {
  if (!state.isRunning) {
    return;
  }
  process.kill(state.daemonPid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!state.isRunning) {
    return;
  }
  try {
    process.kill(state.daemonPid, 'SIGKILL');
  } catch {
    // Process may have exited during grace period.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!state.isRunning) {
    return;
  }
  if (typeof childProcess.kill === 'function') {
    childProcess.kill('SIGKILL');
  }
}

void main().catch((error: unknown) => {
  void flushIpc({
    type: 'failed',
    errorText: error instanceof Error ? error.message : String(error),
  })
    .catch(() => undefined)
    .finally(() => {
      process.exit(1);
    });
});
