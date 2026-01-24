import { spawn } from 'node:child_process';
import type { FuncTool, ToolArguments } from '../dominds-tool';
import { resolveInWorkspace } from './_path';

type ShellCommandArgs = Readonly<{
  command: string;
  workdir?: string;
  login?: boolean;
  timeout_ms?: number;
  sandbox_permissions?: unknown;
  justification?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseShellCommandArgs(args: ToolArguments): ShellCommandArgs {
  const commandValue = args['command'];
  if (typeof commandValue !== 'string' || commandValue.trim() === '') {
    throw new Error('shell_command.command must be a non-empty string');
  }

  const workdirValue = args['workdir'];
  if (workdirValue !== undefined && typeof workdirValue !== 'string') {
    throw new Error('shell_command.workdir must be a string if provided');
  }

  const loginValue = args['login'];
  if (loginValue !== undefined && typeof loginValue !== 'boolean') {
    throw new Error('shell_command.login must be a boolean if provided');
  }

  const timeoutMsValue = args['timeout_ms'] ?? args['timeoutMs'] ?? args['timeout'];
  if (timeoutMsValue !== undefined && typeof timeoutMsValue !== 'number') {
    throw new Error('shell_command.timeout_ms must be a number if provided');
  }

  const sandboxPermissionsValue = args['sandbox_permissions'];
  const justificationValue = args['justification'];
  if (justificationValue !== undefined && typeof justificationValue !== 'string') {
    throw new Error('shell_command.justification must be a string if provided');
  }

  return {
    command: commandValue,
    workdir: workdirValue,
    login: loginValue,
    timeout_ms: timeoutMsValue,
    sandbox_permissions: sandboxPermissionsValue,
    justification: justificationValue,
  };
}

function resolveDefaultShell(): { shellPath: string; supportsLogin: boolean } {
  const envShell = process.env['SHELL'];
  if (typeof envShell === 'string' && envShell.trim() !== '') {
    const shellPath = envShell;
    const base = shellPath.split('/').pop() ?? shellPath;
    const supportsLogin = base === 'bash' || base === 'zsh';
    return { shellPath, supportsLogin };
  }
  return { shellPath: 'bash', supportsLogin: true };
}

function formatTruncation(label: string, truncatedChars: number): string {
  if (truncatedChars <= 0) return '';
  return `\n…(${label} truncated by ${truncatedChars} chars)`;
}

async function runShellCommand(params: ShellCommandArgs): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  stdoutTruncatedBy: number;
  stderrTruncatedBy: number;
}> {
  const start = Date.now();
  const maxCaptureChars = 200_000;
  let stdout = '';
  let stderr = '';
  let stdoutTruncatedBy = 0;
  let stderrTruncatedBy = 0;

  const { shellPath, supportsLogin } = resolveDefaultShell();
  const useLogin = params.login === true && supportsLogin;
  const argv = useLogin ? ['-lc', params.command] : ['-c', params.command];

  const workspaceRoot = process.cwd();
  const cwd =
    typeof params.workdir === 'string' && params.workdir.trim() !== ''
      ? resolveInWorkspace(workspaceRoot, params.workdir, 'shell_command.workdir')
      : workspaceRoot;

  const child = spawn(shellPath, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length >= maxCaptureChars) {
      stdoutTruncatedBy += chunk.length;
      return;
    }
    const str = chunk.toString('utf8');
    const nextLen = stdout.length + str.length;
    if (nextLen <= maxCaptureChars) {
      stdout += str;
      return;
    }
    const keep = Math.max(0, maxCaptureChars - stdout.length);
    stdout += str.slice(0, keep);
    stdoutTruncatedBy += str.length - keep;
  });

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length >= maxCaptureChars) {
      stderrTruncatedBy += chunk.length;
      return;
    }
    const str = chunk.toString('utf8');
    const nextLen = stderr.length + str.length;
    if (nextLen <= maxCaptureChars) {
      stderr += str;
      return;
    }
    const keep = Math.max(0, maxCaptureChars - stderr.length);
    stderr += str.slice(0, keep);
    stderrTruncatedBy += str.length - keep;
  });

  const timeoutMs =
    typeof params.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : 0;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 250);
    }, timeoutMs);
  }

  const exitInfo = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    },
  );

  if (timeoutHandle) clearTimeout(timeoutHandle);

  return {
    exitCode: exitInfo.exitCode,
    signal: exitInfo.signal,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - start,
    stdoutTruncatedBy,
    stderrTruncatedBy,
  };
}

export const shellCommandTool: FuncTool = {
  type: 'func',
  name: 'shell_command',
  description:
    'Execute a shell command (string). Supports optional workdir/login/timeout_ms. Compatibility port of Codex CLI shell_command.',
  parameters: {
    type: 'object',
    additionalProperties: true,
    required: ['command'],
    properties: {
      command: { type: 'string' },
      workdir: { type: 'string' },
      login: { type: 'boolean' },
      timeout_ms: { type: 'number' },
      sandbox_permissions: {},
      justification: { type: 'string' },
    },
  },
  async call(_dlg: unknown, _caller: unknown, args: ToolArguments): Promise<string> {
    const parsed = parseShellCommandArgs(args);

    // Explicitly ignore sandbox_permissions/justification; accepted for compatibility only.
    if (parsed.sandbox_permissions !== undefined && !isRecord(parsed.sandbox_permissions)) {
      // If provided, allow any JSON-ish value without deep validation; don't reject.
    }

    const res = await runShellCommand(parsed);

    const fence = '```console';
    const endFence = '```';
    const status = res.timedOut ? 'timeout' : String(res.exitCode ?? 'unknown');
    const stdoutNotice = formatTruncation('stdout', res.stdoutTruncatedBy);
    const stderrNotice = formatTruncation('stderr', res.stderrTruncatedBy);

    let out = `exit_code: ${status}\nduration_ms: ${res.durationMs}\n`;
    if (res.signal) {
      out += `signal: ${res.signal}\n`;
    }
    out += `\nstdout:\n${fence}\n${res.stdout}${stdoutNotice}\n${endFence}\n\n`;
    out += `stderr:\n${fence}\n${res.stderr}${stderrNotice}\n${endFence}\n`;
    return out;
  },
};
