/**
 * Module: tools/os
 *
 * Operating system interaction tools for shell command execution.
 * Provides shell_cmd and stop_daemon FuncTools with advanced process management.
 */

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { ChildProcess, execFile, fork, spawn } from 'child_process';
import crypto from 'crypto';
import fsSync from 'fs';
import { createRequire } from 'module';
import net from 'net';
import path from 'path';
import { promisify } from 'util';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { getWorkLanguage } from '../runtime/work-language';
import { loadAgentSharedReminders, mutateAgentSharedReminders } from '../shared-reminders';
import { Team } from '../team';
import type {
  FuncTool,
  JsonObject,
  JsonSchema,
  JsonValue,
  Reminder,
  ReminderOwner,
  ReminderUpdateResult,
  ToolArguments,
  ToolCallOutput,
} from '../tool';
import {
  materializeReminder,
  reminderOwnedBy,
  toolFailure,
  toolPartialFailure,
  toolSuccess,
} from '../tool';
import {
  parseCmdRunnerInitialIpcMessage,
  parseCmdRunnerResponseLine,
  type CmdRunnerInitMessage,
  type CmdRunnerInitialIpcMessage,
  type CmdRunnerResponse,
} from './cmd-runner-protocol';
import { truncateToolOutputText } from './output-limit';

const execFileAsync = promisify(execFile);
const requireFn = createRequire(__filename);

// Scrolling buffer that maintains a fixed number of lines like a terminal
class ScrollingBuffer {
  private lines: string[] = [];
  private linesScrolledOut = 0;

  constructor(private maxLines: number) {}

  addLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
      this.linesScrolledOut++;
    }
  }

  addText(text: string): void {
    const newLines = text.split('\n');
    // Don't add empty line at the end if text ends with newline
    if (newLines[newLines.length - 1] === '') {
      newLines.pop();
    }

    for (const line of newLines) {
      this.addLine(line);
    }
  }

  getContent(): string {
    return this.lines.join('\n');
  }

  getScrollInfo(): { linesScrolledOut: number; hasScrolledContent: boolean } {
    return {
      linesScrolledOut: this.linesScrolledOut,
      hasScrolledContent: this.linesScrolledOut > 0,
    };
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }
}

class HeadTailByteBuffer {
  private readonly maxBytes: number;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private omittedBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.headBudget = Math.floor(this.maxBytes / 2);
    this.tailBudget = this.maxBytes - this.headBudget;
  }

  addBytes(chunk: Buffer): void {
    if (this.maxBytes === 0) {
      this.omittedBytes += chunk.length;
      return;
    }

    if (this.headBytes < this.headBudget) {
      const remainingHead = this.headBudget - this.headBytes;
      if (chunk.length <= remainingHead) {
        this.head.push(chunk);
        this.headBytes += chunk.length;
        return;
      }

      const headPart = chunk.subarray(0, remainingHead);
      const tailPart = chunk.subarray(remainingHead);
      if (headPart.length > 0) {
        this.head.push(headPart);
        this.headBytes += headPart.length;
      }
      this.pushToTail(tailPart);
      return;
    }

    this.pushToTail(chunk);
  }

  addText(text: string): void {
    this.addBytes(Buffer.from(text));
  }

  private pushToTail(chunk: Buffer): void {
    if (this.tailBudget === 0) {
      this.omittedBytes += chunk.length;
      return;
    }

    if (chunk.length >= this.tailBudget) {
      this.omittedBytes += this.tailBytes;
      this.tail.length = 0;
      this.tailBytes = 0;

      const kept = chunk.subarray(chunk.length - this.tailBudget);
      const omitted = chunk.length - kept.length;
      this.omittedBytes += omitted;

      if (kept.length > 0) {
        this.tail.push(kept);
        this.tailBytes = kept.length;
      }
      return;
    }

    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailBudget && this.tail.length > 0) {
      const dropped = this.tail.shift();
      if (!dropped) break;
      this.tailBytes -= dropped.length;
      this.omittedBytes += dropped.length;
    }
  }

  getOmittedBytes(): number {
    return this.omittedBytes;
  }

  isEmpty(): boolean {
    return this.headBytes === 0 && this.tailBytes === 0;
  }

  getContent(): string {
    const chunks: Buffer[] = [];
    chunks.push(...this.head);
    chunks.push(...this.tail);
    return Buffer.concat(chunks).toString();
  }
}

// Daemon process tracking with scrolling buffers
interface DaemonProcess {
  pid: number;
  command: string;
  daemonCommandLine?: string;
  shell: string;
  process?: ChildProcess;
  processGroupId?: number;
  startTime: Date;
  stdoutBuffer: ScrollingBuffer;
  stderrBuffer: ScrollingBuffer;
  outputAvailable: boolean;
  isRunning: boolean;
  exitCode?: number;
  exitSignal?: string;
  lastUpdateTime: Date;
}

// Global registry for daemon processes
const daemonProcesses = new Map<number, DaemonProcess>();

export function resetTrackedDaemonsForTests(): void {
  daemonProcesses.clear();
}

// Shell command arguments interface
interface ShellCmdArgs {
  command: string;
  shell?: string;
  scrollbackLines?: number;
  timeoutSeconds?: number;
}

interface ReadonlyShellArgs {
  command: string;
  timeoutMs?: number;
}

// Stop daemon arguments interface
interface StopDaemonArgs {
  pid: number;
  entirePg: boolean;
}

// Get daemon output arguments interface
interface GetDaemonOutputArgs {
  pid: number;
  stdout: boolean;
  stderr: boolean;
}

type ShellSpawnSpec = Readonly<{
  command: string;
  args: string[];
  shellLabel: string;
}>;

function resolveBestEffortDaemonSignalTarget(daemon: DaemonProcess): number {
  if (process.platform !== 'win32' && daemon.processGroupId !== undefined) {
    return -daemon.processGroupId;
  }
  return daemon.pid;
}

function parseStartTime(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid daemon startTime '${value}'`);
  }
  return parsed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeProcessCommandLine(commandLine: string): string {
  return commandLine.trim().replace(/['"`]/g, '').replace(/\s+/g, ' ').toLowerCase();
}

async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', command],
        {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
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

async function readProcessStartTime(pid: number): Promise<Date | undefined> {
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CreationDate.ToString('o')) }`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', command],
        {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
      const trimmed = stdout.trim();
      if (trimmed === '') {
        return undefined;
      }
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
    }

    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (trimmed === '') {
      return undefined;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function liveProcessMatchesReminderCommand(
  meta: ShellCmdReminderMeta,
  actualCommandLine: string,
): boolean {
  const normalizedActual = normalizeProcessCommandLine(actualCommandLine);
  const normalizedCommand = normalizeProcessCommandLine(meta.daemonCommandLine);
  return normalizedActual === normalizedCommand;
}

function liveProcessStartTimeMatchesReminder(
  meta: ShellCmdReminderMeta,
  actualStartTime: Date,
): boolean {
  const expectedStartTime = parseStartTime(meta.startTime);
  return Math.abs(actualStartTime.getTime() - expectedStartTime.getTime()) <= 10_000;
}

async function createRestoredDaemon(
  meta: ShellCmdReminderMeta,
): Promise<DaemonProcess | undefined> {
  if (!isProcessAlive(meta.pid)) {
    return undefined;
  }
  const actualCommandLine = await readProcessCommandLine(meta.pid);
  const actualStartTime = await readProcessStartTime(meta.pid);
  if (
    actualCommandLine === undefined ||
    actualStartTime === undefined ||
    !liveProcessMatchesReminderCommand(meta, actualCommandLine) ||
    !liveProcessStartTimeMatchesReminder(meta, actualStartTime)
  ) {
    return undefined;
  }
  return {
    pid: meta.pid,
    command: meta.initialCommandLine,
    daemonCommandLine: actualCommandLine,
    shell: meta.shell,
    processGroupId: meta.processGroupId,
    startTime: parseStartTime(meta.startTime),
    stdoutBuffer: new ScrollingBuffer(1),
    stderrBuffer: new ScrollingBuffer(1),
    outputAvailable: false,
    isRunning: true,
    lastUpdateTime: new Date(),
  };
}

async function ensureTrackedDaemonFromReminder(
  reminder: ShellCmdOwnedReminder,
): Promise<DaemonProcess | undefined> {
  if (!isShellCmdReminderMeta(reminder.meta)) {
    return undefined;
  }
  const existing = daemonProcesses.get(reminder.meta.pid);
  if (existing) {
    return existing;
  }
  const restored = await createRestoredDaemon(reminder.meta);
  if (!restored) {
    return undefined;
  }
  daemonProcesses.set(restored.pid, restored);
  return restored;
}

async function ensureTrackedDaemonForAgent(
  agentId: string,
  pid: number,
): Promise<DaemonProcess | undefined> {
  const existing = daemonProcesses.get(pid);
  if (existing) {
    return existing;
  }
  const reminders = await loadAgentSharedReminders(agentId);
  for (const reminder of reminders) {
    if (isShellCmdReminder(reminder) && reminder.meta.pid === pid) {
      return await ensureTrackedDaemonFromReminder(reminder);
    }
  }
  return undefined;
}

type ShellCmdReminderMeta = JsonObject & {
  kind: 'daemon';
  pid: number;
  runnerPid?: number;
  runnerEndpoint?: string;
  initialCommandLine: string;
  daemonCommandLine: string;
  shell: string;
  startTime: string;
  processGroupId?: number;
  originDialogId?: string;
  completed?: boolean;
  lastUpdated?: string;
  stdoutDigestSha256?: string;
  stdoutLinesScrolledOut?: number;
  stderrDigestSha256?: string;
  stderrLinesScrolledOut?: number;
  recoveryErrorText?: string;
};

type ShellCmdOwnedReminder = Reminder & {
  owner: ReminderOwner;
  meta: ShellCmdReminderMeta;
};

function isShellCmdReminder(reminder: Reminder): reminder is ShellCmdOwnedReminder {
  return (
    reminderOwnedBy(reminder, shellCmdReminderOwner.name) && isShellCmdReminderMeta(reminder.meta)
  );
}

function buildShellCmdReminderMeta(
  previousMeta: ShellCmdReminderMeta,
  daemon: RunnerBackedDaemon,
  options?: Readonly<{
    completed?: boolean;
    lastUpdated?: string;
  }>,
): JsonObject {
  const outputFingerprint = buildDaemonOutputFingerprint(daemon);
  const nextMeta: JsonObject = {
    kind: 'daemon',
    pid: daemon.pid,
    initialCommandLine: previousMeta.initialCommandLine,
    shell: previousMeta.shell,
    startTime: previousMeta.startTime,
    update: {
      altInstruction: `get_daemon_output({ "pid": ${daemon.pid} })`,
    },
  };
  if (!options?.completed) {
    nextMeta['delete'] = {
      altInstruction: `stop_daemon({ "pid": ${daemon.pid} })`,
    };
  }
  nextMeta['daemonCommandLine'] = daemon.daemonCommandLine;
  nextMeta['runnerPid'] = daemon.runnerPid;
  nextMeta['runnerEndpoint'] = daemon.runnerEndpoint;
  if (previousMeta.originDialogId !== undefined) {
    nextMeta['originDialogId'] = previousMeta.originDialogId;
  }
  if (daemon.processGroupId !== undefined) {
    nextMeta['processGroupId'] = daemon.processGroupId;
  }
  if (options?.completed) {
    nextMeta['completed'] = true;
  }
  if (options?.lastUpdated !== undefined) {
    nextMeta['lastUpdated'] = options.lastUpdated;
  }
  nextMeta['stdoutDigestSha256'] = outputFingerprint.stdoutDigestSha256;
  nextMeta['stdoutLinesScrolledOut'] = outputFingerprint.stdoutLinesScrolledOut;
  nextMeta['stderrDigestSha256'] = outputFingerprint.stderrDigestSha256;
  nextMeta['stderrLinesScrolledOut'] = outputFingerprint.stderrLinesScrolledOut;
  return nextMeta;
}

function sha256HexUtf8(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

type DaemonOutputFingerprint = Readonly<{
  stdoutDigestSha256: string;
  stdoutLinesScrolledOut: number;
  stderrDigestSha256: string;
  stderrLinesScrolledOut: number;
}>;

function buildDaemonOutputFingerprint(daemon: RunnerBackedDaemon): DaemonOutputFingerprint {
  return {
    stdoutDigestSha256: sha256HexUtf8(daemon.stdoutContent),
    stdoutLinesScrolledOut: daemon.stdoutLinesScrolledOut,
    stderrDigestSha256: sha256HexUtf8(daemon.stderrContent),
    stderrLinesScrolledOut: daemon.stderrLinesScrolledOut,
  };
}

function daemonOutputFingerprintMatchesReminder(
  meta: ShellCmdReminderMeta,
  daemon: RunnerBackedDaemon,
): boolean {
  const current = buildDaemonOutputFingerprint(daemon);
  return (
    meta.stdoutDigestSha256 === current.stdoutDigestSha256 &&
    meta.stdoutLinesScrolledOut === current.stdoutLinesScrolledOut &&
    meta.stderrDigestSha256 === current.stderrDigestSha256 &&
    meta.stderrLinesScrolledOut === current.stderrLinesScrolledOut
  );
}

function buildShellCmdRecoveryErrorMeta(
  previousMeta: ShellCmdReminderMeta,
  errorText: string,
  lastUpdated: string,
): JsonObject {
  return {
    ...(previousMeta as JsonObject),
    recoveryErrorText: errorText,
    lastUpdated,
  };
}

function buildShellCmdFinalizedMeta(
  previousMeta: ShellCmdReminderMeta,
  lastUpdated: string,
): JsonObject {
  const { delete: _delete, recoveryErrorText: _recoveryErrorText, ...rest } = previousMeta;
  return {
    ...rest,
    kind: 'daemon',
    completed: true,
    lastUpdated,
    update: {
      altInstruction: `get_daemon_output({ "pid": ${previousMeta.pid} })`,
    },
  };
}

function formatExitedDaemonReminderContent(
  pid: number,
  language: LanguageCode,
  lastKnownSnapshot: string,
): string {
  return language === 'zh'
    ? `🏁 守护进程 ${pid} 已退出。
如需核对最后 stdout/stderr，可先按需调用 get_daemon_output({ "pid": ${pid} })；若该调用已不可用，则以下保留的是最后一次已知快照。确认已知悉后，请手动删除这条提醒。

最后一次已知状态快照：
${lastKnownSnapshot}`
    : `🏁 Daemon process ${pid} has exited.
If you need to verify the final stdout/stderr, first call get_daemon_output({ "pid": ${pid} }) if it is still available; otherwise use the last known snapshot below. After you have acknowledged the exit, delete this reminder manually.

Last known status snapshot:
${lastKnownSnapshot}`;
}

type OsToolMessages = Readonly<{
  daemonStarted: (pid: number, timeoutSeconds: number, command: string) => string;
  commandCompleted: (exitCode: number | null, scrollNotice: string) => string;
  scrolledLinesNotice: (lines: number) => string;
  stdoutLabel: string;
  stderrLabel: string;
  failedToExecute: (msg: string) => string;
  noDaemonFound: (pid: number) => string;
  daemonStopped: (pid: number, command: string) => string;
  failedToStop: (pid: number, msg: string) => string;
  daemonOutputHeader: (pid: number, streamLabel: string) => string;
  noOutput: string;
  scrolledOutNotice: (lines: number) => string;
}>;

function getOsToolMessages(language: LanguageCode): OsToolMessages {
  if (language === 'zh') {
    return {
      daemonStarted: (pid, timeoutSeconds, _command) =>
        `🔄 命令已作为守护进程启动（PID: ${pid}）\n该进程在 ${timeoutSeconds} 秒内未完成，已在后台继续运行。\n已添加提醒以跟踪其进度。\n\n需要时可使用 stop_daemon({"pid": ${pid}}) 终止该进程。`,
      commandCompleted: (exitCode, scrollNotice) =>
        `✅ 命令已完成（退出码：${exitCode ?? 'unknown'}）${scrollNotice}\n\n`,
      scrolledLinesNotice: (lines) => `\n⚠️  执行期间有 ${lines} 行已滚出可视范围`,
      stdoutLabel: '📤 stdout：',
      stderrLabel: '📤 stderr：',
      failedToExecute: (msg) => `❌ 执行命令失败：${msg}`,
      noDaemonFound: (pid) => `❌ 未找到 PID 为 ${pid} 的守护进程`,
      daemonStopped: (pid, command) => `✅ 守护进程 ${pid}（${command}）已停止`,
      failedToStop: (pid, msg) => `❌ 停止守护进程 ${pid} 失败：${msg}`,
      daemonOutputHeader: (pid, streamLabel) => `📤 守护进程 ${pid} ${streamLabel} 输出：\n`,
      noOutput: '(无输出)',
      scrolledOutNotice: (lines) => `\n\n⚠️  有 ${lines} 行已滚出可视范围`,
    };
  }

  return {
    daemonStarted: (pid, timeoutSeconds, _command) =>
      `🔄 Command started as daemon process (PID: ${pid})\nThe process didn't complete within ${timeoutSeconds} seconds and is now running in the background.\nA reminder has been added to track its progress.\n\nUse stop_daemon({"pid": ${pid}}) to terminate it when needed.`,
    commandCompleted: (exitCode, scrollNotice) =>
      `✅ Command completed (exit code: ${exitCode ?? 'unknown'})${scrollNotice}\n\n`,
    scrolledLinesNotice: (lines) => `\n⚠️  ${lines} lines scrolled out of view during execution`,
    stdoutLabel: '📤 stdout:',
    stderrLabel: '📤 stderr:',
    failedToExecute: (msg) => `❌ Failed to execute command: ${msg}`,
    noDaemonFound: (pid) => `❌ No daemon process found with PID ${pid}`,
    daemonStopped: (pid, command) => `✅ Daemon process ${pid} (${command}) stopped successfully`,
    failedToStop: (pid, msg) => `❌ Failed to stop daemon process ${pid}: ${msg}`,
    daemonOutputHeader: (pid, streamLabel) => `📤 Daemon ${pid} ${streamLabel} output:\n`,
    noOutput: '(no output)',
    scrolledOutNotice: (lines) => `\n\n⚠️  ${lines} lines have scrolled out of view`,
  };
}

type SpawnedCmdRunner = Readonly<{
  runnerProcess: ChildProcess;
  initialMessage: CmdRunnerInitialIpcMessage;
}>;

function disconnectRunnerProcess(runnerProcess: ChildProcess): void {
  try {
    if (runnerProcess.connected) {
      runnerProcess.disconnect();
    }
  } catch {
    // Best effort only.
  }
  runnerProcess.unref();
}

async function spawnCmdRunner(init: CmdRunnerInitMessage): Promise<SpawnedCmdRunner> {
  const entry = resolveCmdRunnerEntrypointAbs();
  if (!entry.ok) {
    throw new Error(entry.errorText);
  }

  const runnerProcess = fork(entry.scriptAbs, [], {
    execArgv: entry.execArgv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  if (typeof runnerProcess.send !== 'function') {
    throw new Error('Failed to start cmd_runner: child process has no IPC channel');
  }

  return await new Promise<SpawnedCmdRunner>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          runnerProcess.kill('SIGTERM');
        } catch {
          // Best effort only.
        }
        reject(new Error('cmd_runner init timed out waiting for initial result'));
      },
      (init.timeoutSeconds + 10) * 1000,
    );

    const finalize = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn();
    };

    runnerProcess.once('exit', (code, signal) => {
      finalize(() => {
        reject(
          new Error(
            `cmd_runner exited before returning initial result (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
          ),
        );
      });
    });

    runnerProcess.on('message', (raw: unknown) => {
      finalize(() => {
        try {
          resolve({
            runnerProcess,
            initialMessage: parseCmdRunnerInitialIpcMessage(raw),
          });
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    runnerProcess.send(init);
  });
}

function formatCompletedShellCommandOutput(
  message: Extract<CmdRunnerInitialIpcMessage, { type: 'completed' }>,
  t: OsToolMessages,
): ToolCallOutput {
  const stdoutHasScrolled = message.stdout.linesScrolledOut > 0;
  const stderrHasScrolled = message.stderr.linesScrolledOut > 0;
  let scrollNotice = '';
  if (stdoutHasScrolled || stderrHasScrolled) {
    scrollNotice = t.scrolledLinesNotice(
      message.stdout.linesScrolledOut + message.stderr.linesScrolledOut,
    );
  }

  const stdoutContent = truncateToolOutputText(message.stdout.content, {
    toolName: 'shell_cmd_stdout',
  }).text;
  const stderrContent = truncateToolOutputText(message.stderr.content, {
    toolName: 'shell_cmd_stderr',
  }).text;

  const fenceConsole = '```console';
  const fenceEnd = '```';
  let result = t.commandCompleted(message.exitCode, scrollNotice);

  if (stdoutContent !== '') {
    result += `${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}\n\n`;
  }
  if (stderrContent !== '') {
    result += `${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
  }
  const content = result.trim();
  return message.exitCode === 0 ? toolSuccess(content) : toolPartialFailure(content);
}

async function removeDaemonRemindersForPid(dlg: Dialog, pid: number): Promise<void> {
  const indicesToRemove: number[] = [];
  for (let i = 0; i < dlg.reminders.length; i++) {
    const reminder = dlg.reminders[i];
    if (isShellCmdReminder(reminder) && reminder.meta.pid === pid) {
      indicesToRemove.push(i);
    }
  }
  for (let i = indicesToRemove.length - 1; i >= 0; i--) {
    dlg.deleteReminder(indicesToRemove[i]);
  }
  await mutateAgentSharedReminders(dlg.agentId, (reminders) => {
    for (let i = reminders.length - 1; i >= 0; i--) {
      const reminder = reminders[i];
      if (isShellCmdReminder(reminder) && reminder.meta.pid === pid) {
        reminders.splice(i, 1);
      }
    }
  });
  dlg.touchReminders();
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Private schema for reminders owned by `shellCmdReminderOwner` only.
// Framework code must first route by owner before interpreting this payload.
function isShellCmdReminderMeta(meta: JsonValue | undefined): meta is ShellCmdReminderMeta {
  return (
    isJsonObject(meta) &&
    meta.kind === 'daemon' &&
    typeof meta.pid === 'number' &&
    (meta.runnerPid === undefined || typeof meta.runnerPid === 'number') &&
    (meta.runnerEndpoint === undefined || typeof meta.runnerEndpoint === 'string') &&
    typeof meta.initialCommandLine === 'string' &&
    typeof meta.daemonCommandLine === 'string' &&
    typeof meta.shell === 'string' &&
    typeof meta.startTime === 'string'
  );
}

function parseShellCmdArgs(args: ToolArguments): ShellCmdArgs {
  const command = args.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('shell_cmd.command must be a string');
  }

  const shell = args.shell;
  if (shell !== undefined && typeof shell !== 'string') {
    throw new Error('shell_cmd.shell must be a string if provided');
  }

  const scrollbackLines = args.scrollbackLines;
  if (scrollbackLines !== undefined && typeof scrollbackLines !== 'number') {
    throw new Error('shell_cmd.scrollbackLines must be a number if provided');
  }

  const timeoutSeconds = args.timeoutSeconds;
  if (timeoutSeconds !== undefined && typeof timeoutSeconds !== 'number') {
    throw new Error('shell_cmd.timeoutSeconds must be a number if provided');
  }

  return {
    command,
    shell: typeof shell === 'string' && shell.trim() !== '' ? shell : undefined,
    scrollbackLines:
      scrollbackLines === 0
        ? undefined
        : scrollbackLines === undefined
          ? undefined
          : Number.isInteger(scrollbackLines) && scrollbackLines > 0
            ? scrollbackLines
            : (() => {
                throw new Error(
                  'shell_cmd.scrollbackLines must be a positive integer (or 0 for default)',
                );
              })(),
    timeoutSeconds:
      timeoutSeconds === 0
        ? undefined
        : timeoutSeconds === undefined
          ? undefined
          : Number.isInteger(timeoutSeconds) && timeoutSeconds > 0
            ? timeoutSeconds
            : (() => {
                throw new Error(
                  'shell_cmd.timeoutSeconds must be a positive integer (or 0 for default)',
                );
              })(),
  };
}

function parseReadonlyShellArgs(args: ToolArguments): ReadonlyShellArgs {
  const command = args.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('readonly_shell.command must be a string');
  }

  const timeoutAlias = args.timeout;
  if (timeoutAlias !== undefined && typeof timeoutAlias !== 'number') {
    throw new Error('readonly_shell.timeout must be a number if provided');
  }

  const timeoutMs = args.timeout_ms;
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
    throw new Error('readonly_shell.timeout_ms must be a number if provided');
  }

  return {
    command,
    timeoutMs:
      timeoutMs === undefined
        ? timeoutAlias === undefined
          ? undefined
          : timeoutAlias === 0
            ? undefined
            : Number.isInteger(timeoutAlias) && timeoutAlias > 0
              ? timeoutAlias
              : (() => {
                  throw new Error(
                    'readonly_shell.timeout must be a positive integer (or 0 for default)',
                  );
                })()
        : timeoutMs === 0
          ? undefined
          : Number.isInteger(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : (() => {
                throw new Error(
                  'readonly_shell.timeout_ms must be a positive integer (or 0 for default)',
                );
              })(),
  };
}

function parseStopDaemonArgs(args: ToolArguments): StopDaemonArgs {
  const pid = args.pid;
  if (typeof pid !== 'number') {
    throw new Error('stop_daemon.pid must be a number');
  }

  const entirePg = args.entire_pg;
  if (entirePg !== undefined && typeof entirePg !== 'boolean') {
    throw new Error('stop_daemon.entire_pg must be a boolean if provided');
  }

  if (process.platform === 'win32' && entirePg === true) {
    throw new Error('stop_daemon.entire_pg=true is unsupported on Windows');
  }

  return {
    pid,
    entirePg: entirePg ?? process.platform !== 'win32',
  };
}

function parseGetDaemonOutputArgs(args: ToolArguments): GetDaemonOutputArgs {
  const pid = args.pid;
  if (typeof pid !== 'number') {
    throw new Error('get_daemon_output.pid must be a number');
  }

  const stdoutRaw = args.stdout;
  if (stdoutRaw !== undefined && typeof stdoutRaw !== 'boolean') {
    throw new Error('get_daemon_output.stdout must be a boolean if provided');
  }
  const stderrRaw = args.stderr;
  if (stderrRaw !== undefined && typeof stderrRaw !== 'boolean') {
    throw new Error('get_daemon_output.stderr must be a boolean if provided');
  }
  const stdout = stdoutRaw ?? true;
  const stderr = stderrRaw ?? true;
  if (!stdout && !stderr) {
    throw new Error('get_daemon_output requires at least one of stdout/stderr to be true');
  }
  return { pid, stdout, stderr };
}

function resolveShellCmdSpawnSpec(command: string, shell: string | undefined): ShellSpawnSpec {
  const preferredShell =
    typeof shell === 'string' && shell.trim() !== '' ? shell.trim() : undefined;
  if (process.platform === 'win32') {
    if (preferredShell) {
      const base = path.basename(preferredShell).toLowerCase();
      if (
        base === 'powershell' ||
        base === 'powershell.exe' ||
        base === 'pwsh' ||
        base === 'pwsh.exe'
      ) {
        return {
          command: preferredShell,
          args: ['-NoLogo', '-NoProfile', '-Command', command],
          shellLabel: preferredShell,
        };
      }
      if (base === 'cmd' || base === 'cmd.exe') {
        return {
          command: preferredShell,
          args: ['/d', '/s', '/c', command],
          shellLabel: preferredShell,
        };
      }
      return {
        command: preferredShell,
        args: ['-c', command],
        shellLabel: preferredShell,
      };
    }
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      shellLabel: 'cmd.exe',
    };
  }

  const resolvedShell = preferredShell ?? 'bash';
  return {
    command: resolvedShell,
    args: ['-c', command],
    shellLabel: resolvedShell,
  };
}

function resolveReadonlyShellSpawnSpec(
  command: string,
): Readonly<{ command: string; args: string[] }> {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { command: 'bash', args: ['-c', command] };
}

type RunnerBackedDaemon = Readonly<{
  pid: number;
  runnerPid: number;
  runnerEndpoint: string;
  command: string;
  daemonCommandLine: string;
  shell: string;
  processGroupId?: number;
  startTime: Date;
  stdoutContent: string;
  stdoutLinesScrolledOut: number;
  stderrContent: string;
  stderrLinesScrolledOut: number;
  isRunning: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  lastUpdateTime: Date;
}>;

type ResolveRunnerBackedDaemonResult =
  | Readonly<{ kind: 'live'; daemon: RunnerBackedDaemon }>
  | Readonly<{ kind: 'gone' }>
  | Readonly<{ kind: 'error'; errorText: string }>;

type CmdRunnerEntrypointResolution =
  | Readonly<{ ok: true; scriptAbs: string; execArgv: string[] }>
  | Readonly<{ ok: false; errorText: string }>;

function resolveCmdRunnerEntrypointAbs(): CmdRunnerEntrypointResolution {
  const distCandidate = path.resolve(__dirname, 'cmd-runner.js');
  if (fsSync.existsSync(distCandidate)) {
    return { ok: true, scriptAbs: distCandidate, execArgv: [] };
  }
  const tsCandidate = path.resolve(__dirname, 'cmd-runner.ts');
  if (fsSync.existsSync(tsCandidate)) {
    const tsxLoaderAbs = requireFn.resolve('tsx');
    return { ok: true, scriptAbs: tsCandidate, execArgv: ['--import', tsxLoaderAbs] };
  }
  return {
    ok: false,
    errorText: `Cannot find cmd_runner entrypoint at ${distCandidate} or ${tsCandidate}`,
  };
}

function buildRunnerBackedDaemon(
  meta: ShellCmdReminderMeta,
  response: Extract<CmdRunnerResponse, { ok: true }>,
): RunnerBackedDaemon {
  return {
    pid: response.daemonPid,
    runnerPid: response.runnerPid,
    runnerEndpoint: response.endpoint,
    command: meta.initialCommandLine,
    daemonCommandLine: response.daemonCommandLine,
    shell: response.shell,
    processGroupId: response.processGroupId,
    startTime: parseStartTime(response.startTime),
    stdoutContent: response.stdout.content,
    stdoutLinesScrolledOut: response.stdout.linesScrolledOut,
    stderrContent: response.stderr.content,
    stderrLinesScrolledOut: response.stderr.linesScrolledOut,
    isRunning: response.isRunning,
    exitCode: response.exitCode,
    exitSignal: response.exitSignal,
    lastUpdateTime: new Date(),
  };
}

function runnerResponseMatchesReminder(
  meta: ShellCmdReminderMeta,
  response: Extract<CmdRunnerResponse, { ok: true }>,
): boolean {
  if (response.daemonPid !== meta.pid) {
    return false;
  }
  if (!liveProcessMatchesReminderCommand(meta, response.daemonCommandLine)) {
    return false;
  }
  return liveProcessStartTimeMatchesReminder(meta, parseStartTime(response.startTime));
}

async function callRunner(
  endpoint: string,
  request: Readonly<Record<string, unknown>>,
  timeoutMs = 5_000,
): Promise<CmdRunnerResponse> {
  return await new Promise<CmdRunnerResponse>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let buffer = '';

    const finalize = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      socket.destroy();
      fn();
    };

    const timeoutHandle = setTimeout(() => {
      finalize(() => {
        reject(new Error(`cmd_runner request timed out for endpoint ${endpoint}`));
      });
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.once('error', (error) => {
      finalize(() => {
        reject(error);
      });
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      finalize(() => {
        try {
          resolve(parseCmdRunnerResponseLine(line));
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

async function bestEffortKillDaemonProcessGroup(
  meta: ShellCmdReminderMeta,
  options?: Readonly<{ includeEntirePg: boolean }>,
): Promise<void> {
  const includeEntirePg = options?.includeEntirePg ?? true;
  if (includeEntirePg && process.platform !== 'win32' && meta.processGroupId !== undefined) {
    try {
      process.kill(-meta.processGroupId, 'SIGTERM');
    } catch {
      // Best effort only.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      process.kill(-meta.processGroupId, 'SIGKILL');
    } catch {
      // Best effort only.
    }
  }
  try {
    process.kill(meta.pid, 'SIGTERM');
  } catch {
    // Best effort only.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(meta.pid, 'SIGKILL');
  } catch {
    // Best effort only.
  }
}

async function resolveDaemonFromMeta(
  meta: ShellCmdReminderMeta,
): Promise<ResolveRunnerBackedDaemonResult> {
  if (meta.runnerEndpoint !== undefined && meta.runnerEndpoint.trim() !== '') {
    try {
      const response = await callRunner(meta.runnerEndpoint, { type: 'get_status' });
      if (response.ok && runnerResponseMatchesReminder(meta, response)) {
        return { kind: 'live', daemon: buildRunnerBackedDaemon(meta, response) };
      }
    } catch {
      // Fall through to stale-or-gone detection.
    }
  }

  if (!isProcessAlive(meta.pid)) {
    return { kind: 'gone' };
  }

  const actualCommandLine = await readProcessCommandLine(meta.pid);
  const actualStartTime = await readProcessStartTime(meta.pid);
  if (
    actualCommandLine === undefined ||
    actualStartTime === undefined ||
    !liveProcessMatchesReminderCommand(meta, actualCommandLine) ||
    !liveProcessStartTimeMatchesReminder(meta, actualStartTime)
  ) {
    return { kind: 'gone' };
  }

  try {
    await bestEffortKillDaemonProcessGroup(meta);
    return { kind: 'gone' };
  } catch (error: unknown) {
    return {
      kind: 'error',
      errorText:
        error instanceof Error
          ? `stale daemon cleanup failed for pid ${String(meta.pid)}: ${error.message}`
          : `stale daemon cleanup failed for pid ${String(meta.pid)}: ${String(error)}`,
    };
  }
}

function formatRunnerBackedDaemonStatus(
  daemon: RunnerBackedDaemon,
  language: LanguageCode,
): string {
  const uptime = Math.floor((Date.now() - daemon.startTime.getTime()) / 1000);
  const status =
    language === 'zh'
      ? daemon.isRunning
        ? '运行中'
        : `已退出（code: ${daemon.exitCode}, signal: ${daemon.exitSignal}）`
      : daemon.isRunning
        ? 'running'
        : `exited (code: ${daemon.exitCode}, signal: ${daemon.exitSignal})`;

  const stdoutNotice =
    daemon.stdoutLinesScrolledOut > 0
      ? language === 'zh'
        ? `\n注意：stdout 已有 ${daemon.stdoutLinesScrolledOut} 行滚出当前保留缓冲区`
        : `\nNote: stdout has ${daemon.stdoutLinesScrolledOut} lines scrolled out of the retained buffer`
      : '';
  const stderrNotice =
    daemon.stderrLinesScrolledOut > 0
      ? language === 'zh'
        ? `\n注意：stderr 已有 ${daemon.stderrLinesScrolledOut} 行滚出当前保留缓冲区`
        : `\nNote: stderr has ${daemon.stderrLinesScrolledOut} lines scrolled out of the retained buffer`
      : '';
  const stdoutContent =
    daemon.stdoutContent === ''
      ? language === 'zh'
        ? '（无输出）'
        : '(no output)'
      : truncateToolOutputText(daemon.stdoutContent, { toolName: 'daemon_stdout' }).text;
  const stderrContent =
    daemon.stderrContent === ''
      ? language === 'zh'
        ? '（无 stderr 输出）'
        : '(no stderr output)'
      : truncateToolOutputText(daemon.stderrContent, { toolName: 'daemon_stderr' }).text;
  const fenceConsole = '```console';
  const fenceEnd = '```';

  return language === 'zh'
    ? `后台进程 PID: ${daemon.pid}
命令: ${daemon.command}
Shell: ${daemon.shell}
生命周期状态: ${status}
已运行: ${uptime}s
启动时间: ${formatUnifiedTimestamp(daemon.startTime)}${stdoutNotice}${stderrNotice}

stdout 缓冲区快照：
${fenceConsole}
${stdoutContent}
${fenceEnd}

stderr 缓冲区快照：
${fenceConsole}
${stderrContent}
${fenceEnd}`
    : `Daemon PID: ${daemon.pid}
Command: ${daemon.command}
Shell: ${daemon.shell}
Lifecycle status: ${status}
Uptime: ${uptime}s
Started at: ${formatUnifiedTimestamp(daemon.startTime)}${stdoutNotice}${stderrNotice}

Stdout buffer snapshot:
${fenceConsole}
${stdoutContent}
${fenceEnd}

Stderr buffer snapshot:
${fenceConsole}
${stderrContent}
${fenceEnd}`;
}

function formatRunnerRecoveryError(pid: number, errorText: string, language: LanguageCode): string {
  return language === 'zh'
    ? `⚠️ 守护进程 ${pid} 的 runner 恢复失败：${errorText}`
    : `⚠️ Failed to recover runner for daemon ${pid}: ${errorText}`;
}

// JSON Schema for shell_cmd parameters
const shellCmdSchema: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The shell command to execute',
    },
    shell: {
      type: 'string',
      description: 'Shell to use for execution (default: bash on Linux/macOS; cmd.exe on Windows)',
    },
    scrollbackLines: {
      type: 'number',
      description: 'Number of recent output lines to retain in scrollback (default: 500)',
    },
    timeoutSeconds: {
      type: 'number',
      description: 'Timeout in seconds to wait for process completion (default: 5)',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

const readonlyShellSchema: JsonSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'Read-only shell command (allowed prefixes: cat, rg, sed, ls, nl, wc, head, tail, stat, file, uname, whoami, id, echo, pwd, which, date, diff, realpath, readlink, printf, cut, sort, uniq, tr, awk, shasum, sha256sum, md5sum, uuid, git show, git status, git diff, git log, git blame, find, tree, jq, true; exact version probes: node --version|-v, python3 --version|-V; also allows: git -C <relative-path> <show|status|diff|log|blame> ...; also allows: cd <relative-path> && <allowed command...> (or ||); command chains via |/&&/|| are validated segment-by-segment)',
    },
    timeout_ms: {
      type: 'number',
      description: 'Maximum time in milliseconds the command is allowed to run (default: 10000)',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

// JSON Schema for stop_daemon parameters
const stopDaemonSchema: JsonSchema = {
  type: 'object',
  properties: {
    pid: {
      type: 'number',
      description: 'Process ID of the daemon to stop',
    },
    entire_pg: {
      type: 'boolean',
      description:
        'Whether to signal the entire process group instead of only the tracked PID (default: true on Unix-like systems; false on Windows)',
    },
  },
  required: ['pid'],
  additionalProperties: false,
};

// JSON Schema for get_daemon_output parameters
const getDaemonOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    pid: {
      type: 'number',
      description: 'Process ID of the daemon to query',
    },
    stdout: {
      type: 'boolean',
      description:
        'Whether to include stdout output (default: true unless stderr is explicitly set)',
    },
    stderr: {
      type: 'boolean',
      description:
        'Whether to include stderr output (default: true unless stdout is explicitly set)',
    },
  },
  required: ['pid'],
  additionalProperties: false,
};

// Format daemon status for reminder display
function formatDaemonStatus(daemon: DaemonProcess, language: LanguageCode): string {
  const uptime = Math.floor((Date.now() - daemon.startTime.getTime()) / 1000);
  const status =
    language === 'zh'
      ? daemon.isRunning
        ? '运行中'
        : `已退出（code: ${daemon.exitCode}, signal: ${daemon.exitSignal}）`
      : daemon.isRunning
        ? 'running'
        : `exited (code: ${daemon.exitCode}, signal: ${daemon.exitSignal})`;

  const stdoutInfo = daemon.stdoutBuffer.getScrollInfo();
  const stderrInfo = daemon.stderrBuffer.getScrollInfo();

  let scrollNotice = '';
  if (stdoutInfo.hasScrolledContent || stderrInfo.hasScrolledContent) {
    const scrolledLines = stdoutInfo.linesScrolledOut + stderrInfo.linesScrolledOut;
    scrollNotice =
      language === 'zh'
        ? `\n注意：已有 ${scrolledLines} 行滚出当前保留缓冲区`
        : `\nNote: ${scrolledLines} lines have scrolled out of the retained buffer`;
  }
  if (!daemon.outputAvailable) {
    scrollNotice +=
      language === 'zh'
        ? '\n注意：该守护进程是在 Dominds 重启后重新识别到的，旧 stdout/stderr 捕获缓冲区不可恢复。'
        : '\nNote: this daemon was rediscovered after a Dominds restart, so previously captured stdout/stderr buffers are unavailable.';
  }

  const stdoutContent = daemon.stdoutBuffer.isEmpty()
    ? language === 'zh'
      ? '（无输出）'
      : '(no output)'
    : truncateToolOutputText(daemon.stdoutBuffer.getContent(), { toolName: 'daemon_stdout' }).text;
  const stderrContent = daemon.stderrBuffer.isEmpty()
    ? language === 'zh'
      ? '（无 stderr 输出）'
      : '(no stderr output)'
    : truncateToolOutputText(daemon.stderrBuffer.getContent(), { toolName: 'daemon_stderr' }).text;
  const fenceConsole = '```console';
  const fenceEnd = '```';

  return language === 'zh'
    ? `后台进程 PID: ${daemon.pid}
命令: ${daemon.command}
Shell: ${daemon.shell}
生命周期状态: ${status}
已运行: ${uptime}s
启动时间: ${formatUnifiedTimestamp(daemon.startTime)}${scrollNotice}

stdout 缓冲区快照：
${fenceConsole}
${stdoutContent}
${fenceEnd}

stderr 缓冲区快照：
${fenceConsole}
${stderrContent}
${fenceEnd}`
    : `Daemon PID: ${daemon.pid}
Command: ${daemon.command}
Shell: ${daemon.shell}
Lifecycle status: ${status}
Uptime: ${uptime}s
Started at: ${formatUnifiedTimestamp(daemon.startTime)}${scrollNotice}

Stdout buffer snapshot:
${fenceConsole}
${stdoutContent}
${fenceEnd}

Stderr buffer snapshot:
${fenceConsole}
${stderrContent}
${fenceEnd}`;
}

// ReminderOwner implementation for shell command tool
export const shellCmdReminderOwner: ReminderOwner = {
  name: 'shellCmd',
  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (!isShellCmdReminder(reminder)) {
      return { treatment: 'keep' };
    }

    const pid = reminder.meta.pid;
    const resolved = await resolveDaemonFromMeta(reminder.meta);

    if (resolved.kind === 'gone') {
      const isTrackedDaemon =
        reminder.meta.completed === true ||
        reminder.meta.runnerEndpoint !== undefined ||
        reminder.meta.runnerPid !== undefined;
      if (!isTrackedDaemon) {
        return { treatment: 'drop' };
      }
      if (reminder.meta.completed === true) {
        return { treatment: 'keep' };
      }
      return {
        treatment: 'update',
        updatedContent: formatExitedDaemonReminderContent(pid, getWorkLanguage(), reminder.content),
        updatedMeta: buildShellCmdFinalizedMeta(reminder.meta, formatUnifiedTimestamp(new Date())),
      };
    }

    if (resolved.kind === 'error') {
      const errorContent = formatRunnerRecoveryError(pid, resolved.errorText, getWorkLanguage());
      if (
        reminder.meta.recoveryErrorText === resolved.errorText &&
        reminder.content === errorContent
      ) {
        return { treatment: 'keep' };
      }
      return {
        treatment: 'update',
        updatedContent: errorContent,
        updatedMeta: buildShellCmdRecoveryErrorMeta(
          reminder.meta,
          resolved.errorText,
          formatUnifiedTimestamp(new Date()),
        ),
      };
    }

    const daemon = resolved.daemon;

    if (!daemon.isRunning) {
      const completedContent = formatExitedDaemonReminderContent(
        pid,
        getWorkLanguage(),
        formatRunnerBackedDaemonStatus(daemon, getWorkLanguage()),
      );
      if (
        reminder.meta.completed === true &&
        daemonOutputFingerprintMatchesReminder(reminder.meta, daemon) &&
        reminder.content === completedContent
      ) {
        return { treatment: 'keep' };
      }
      return {
        treatment: 'update',
        updatedContent: completedContent,
        updatedMeta: buildShellCmdReminderMeta(reminder.meta, daemon, {
          completed: true,
          lastUpdated: formatUnifiedTimestamp(new Date()),
        }),
      };
    }

    if (daemonOutputFingerprintMatchesReminder(reminder.meta, daemon)) {
      return { treatment: 'keep' };
    }

    return {
      treatment: 'update',
      updatedContent: formatRunnerBackedDaemonStatus(daemon, getWorkLanguage()),
      updatedMeta: buildShellCmdReminderMeta(reminder.meta, daemon, {
        lastUpdated: formatUnifiedTimestamp(daemon.lastUpdateTime),
      }),
    };
  },

  async renderReminder(dlg: Dialog, reminder: Reminder): Promise<ChatMessage> {
    const language = getWorkLanguage();
    const prefix = formatSystemNoticePrefix(language);
    if (!isShellCmdReminder(reminder)) {
      // Fallback to default rendering if this reminder doesn't belong to this tool
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `${prefix} 后台进程状态提醒 [${reminder.id}]
这是系统维护的后台进程状态快照。把它当成环境信号，不是你自己写的工作便签。若它没有实质改变你的判断/计划/风险，则禁止做任何用户可见回应（禁止写“静默吸收”“已收到”等占位语句）；只有它实际影响后续动作时，才在下一条有实质内容的回复中体现相关事实。该提醒在进程运行期间会自动更新；进程结束后会保留终态，等待你确认后手动删除。
---
${reminder.content}`
            : `${prefix} Background process status reminder [${reminder.id}]
This is a system-maintained background process snapshot. Treat it as an environment signal, not a self-authored work note. If it does not materially change your judgment/plan/risk, make no user-visible reply at all (do not send filler like “silently noted” or “received”); only reflect it inside the next substantive reply when it actually affects the next action. This reminder auto-updates while the process is running; after exit it keeps the terminal state until you delete it manually.
---
${reminder.content}`,
      };
    }

    const pid = reminder.meta.pid;
    const resolved = await resolveDaemonFromMeta(reminder.meta);

    if (resolved.kind === 'gone') {
      const isTrackedDaemon =
        reminder.meta.completed === true ||
        reminder.meta.runnerEndpoint !== undefined ||
        reminder.meta.runnerPid !== undefined;
      if (isTrackedDaemon) {
        return {
          type: 'environment_msg',
          role: 'user',
          content:
            language === 'zh'
              ? `${prefix} 进程生命周期提醒 [${reminder.id}] - 后台进程已结束（PID ${pid}）
该后台进程已退出。若需要再核对最后 stdout/stderr，可先按需调用 get_daemon_output({ "pid": ${pid} })；若该调用已不可用，则以下是最后一次已知快照。确认已知悉后，请手动删除这条提醒。
---
${reminder.content}`
              : `${prefix} Process lifecycle reminder [${reminder.id}] - daemon terminated (PID ${pid})
This daemon has exited. If you still need to inspect the final stdout/stderr, first call get_daemon_output({ "pid": ${pid} }) if it is still available; otherwise use the last known snapshot below. After you have acknowledged the exit, delete this reminder manually.
---
${reminder.content}`,
        };
      }
      return {
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `${prefix} 进程生命周期提醒 [${reminder.id}] - 后台进程已结束（PID ${pid}）
该后台进程的生命周期已经结束，当前不再运行。`
            : `${prefix} Process lifecycle reminder [${reminder.id}] - daemon terminated (PID ${pid})
This daemon process has finished its lifecycle and is no longer running.`,
      };
    }

    if (resolved.kind === 'error') {
      return {
        type: 'environment_msg',
        role: 'user',
        content: formatRunnerRecoveryError(pid, resolved.errorText, language),
      };
    }

    const daemon = resolved.daemon;

    const uptime = Math.floor((Date.now() - daemon.startTime.getTime()) / 1000);
    const uptimeStr =
      uptime < 60
        ? `${uptime}s`
        : uptime < 3600
          ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
          : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    const statusInfo = formatRunnerBackedDaemonStatus(daemon, language);

    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `🔄 ${prefix} 运行中后台进程状态 [${reminder.id}] - PID ${pid}（已运行 ${uptimeStr}）
这是系统维护的状态快照，不是新的用户诉求，也不是默认需要单独汇报的事项。若下面的信息没有实质改变你的判断、计划、风险，且不需要调用守护进程相关工具，则禁止做任何用户可见回应；若它有实质影响，只在下一条有实质内容的回复中体现，禁止单独发送“静默吸收”“已收到”等占位语句。

**状态快照：**
${statusInfo}`
          : `🔄 ${prefix} Active daemon state [${reminder.id}] - PID ${pid} (uptime: ${uptimeStr})
This is a system-maintained snapshot, not a new user request and not something that normally deserves a standalone mention. If the information below does not materially change your judgment, plan, risk, or require a daemon-management action, make no user-visible reply at all; if it does matter, reflect it only inside the next substantive reply instead of sending filler like “silently noted” or “received”.

**State snapshot:**
${statusInfo}`,
    };
  },
};

// Shell command tool implementation
export const shellCmdTool: FuncTool = {
  type: 'func',
  name: 'shell_cmd',
  description:
    'Execute shell commands with optional timeout. If timeoutSeconds > 0 and command runs longer, it becomes a tracked daemon process. Daemons persist across messages and require explicit stop_daemon or get_daemon_output calls.',
  descriptionI18n: {
    en: 'Execute shell commands with optional timeout. If timeoutSeconds > 0 and command runs longer, it becomes a tracked daemon process. Daemons persist across messages and require explicit stop_daemon or get_daemon_output calls.',
    zh: '执行 shell 命令（支持超时）。如果 timeoutSeconds > 0 且命令运行时间超过超时，将转为可追踪的后台守护进程。守护进程会跨消息持续存在，需要显式调用 stop_daemon 或 get_daemon_output 来管理与查看输出。',
  },
  parameters: shellCmdSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseShellCmdArgs(args);
    const { command, shell, scrollbackLines = 500, timeoutSeconds = 5 } = parsedArgs;
    const spawnSpec = resolveShellCmdSpawnSpec(command, shell);
    try {
      const { runnerProcess, initialMessage } = await spawnCmdRunner({
        type: 'init',
        initialCommandLine: command,
        spawnSpec: {
          command: spawnSpec.command,
          args: spawnSpec.args,
          shellLabel: spawnSpec.shellLabel,
        },
        timeoutSeconds,
        scrollbackLines,
      });

      if (initialMessage.type === 'completed') {
        return formatCompletedShellCommandOutput(initialMessage, t);
      }

      if (initialMessage.type === 'failed') {
        disconnectRunnerProcess(runnerProcess);
        return toolFailure(t.failedToExecute(initialMessage.errorText));
      }

      const daemon: RunnerBackedDaemon = {
        pid: initialMessage.daemonPid,
        runnerPid: initialMessage.runnerPid,
        runnerEndpoint: initialMessage.endpoint,
        command,
        daemonCommandLine: initialMessage.daemonCommandLine,
        shell: initialMessage.shell,
        processGroupId: initialMessage.processGroupId,
        startTime: parseStartTime(initialMessage.startTime),
        stdoutContent: '',
        stdoutLinesScrolledOut: 0,
        stderrContent: '',
        stderrLinesScrolledOut: 0,
        isRunning: true,
        exitCode: null,
        exitSignal: null,
        lastUpdateTime: new Date(),
      };
      const reminderSeedMeta: ShellCmdReminderMeta = {
        kind: 'daemon',
        pid: initialMessage.daemonPid,
        runnerPid: initialMessage.runnerPid,
        runnerEndpoint: initialMessage.endpoint,
        initialCommandLine: command,
        daemonCommandLine: initialMessage.daemonCommandLine,
        shell: initialMessage.shell,
        startTime: initialMessage.startTime,
        originDialogId: dlg.id.selfId,
      };
      if (initialMessage.processGroupId !== undefined) {
        reminderSeedMeta.processGroupId = initialMessage.processGroupId;
      }
      const reminderMeta = buildShellCmdReminderMeta(reminderSeedMeta, daemon);
      const reminder = materializeReminder({
        content: `[Daemon PID ${initialMessage.daemonPid} - This content should not be visible, check dynamic rendering]`,
        owner: shellCmdReminderOwner,
        meta: reminderMeta,
        scope: 'agent_shared',
      });
      try {
        await mutateAgentSharedReminders(dlg.agentId, (reminders) => {
          reminders.push(reminder);
        });
        dlg.touchReminders();
      } catch (error: unknown) {
        await bestEffortKillDaemonProcessGroup(reminderSeedMeta);
        disconnectRunnerProcess(runnerProcess);
        return toolFailure(
          t.failedToExecute(
            error instanceof Error
              ? `daemon reminder persistence failed: ${error.message}`
              : `daemon reminder persistence failed: ${String(error)}`,
          ),
        );
      }
      disconnectRunnerProcess(runnerProcess);
      return toolSuccess(t.daemonStarted(initialMessage.daemonPid, timeoutSeconds, command));
    } catch (error: unknown) {
      return toolFailure(t.failedToExecute(error instanceof Error ? error.message : String(error)));
    }
  },
};

const readonlyShellAllowedPrefixes = [
  'cat',
  'rg',
  'sed',
  'ls',
  'nl',
  'wc',
  'head',
  'tail',
  'stat',
  'file',
  'uname',
  'whoami',
  'id',
  'echo',
  'pwd',
  'which',
  'date',
  'diff',
  'realpath',
  'readlink',
  'printf',
  'cut',
  'sort',
  'uniq',
  'tr',
  'awk',
  'shasum',
  'sha256sum',
  'md5sum',
  'uuid',
  'git show',
  'git status',
  'git diff',
  'git log',
  'git blame',
  'find',
  'tree',
  'jq',
  'true',
] as const;

function isAllowedReadonlyShellVersionProbe(command: string): boolean {
  const tokens = splitShellTokens(command);
  if (tokens.length !== 2) return false;

  const cmd = tokens[0]?.text ?? '';
  const flag = tokens[1]?.text ?? '';

  if (cmd === 'node') return flag === '--version' || flag === '-v';
  if (cmd === 'python3') return flag === '--version' || flag === '-V';
  return false;
}

type ReadonlyShellValidationFailureReason =
  | 'MAX_DEPTH'
  | 'INVALID_CD_SYNTAX'
  | 'UNSAFE_RELATIVE_PATH'
  | 'CHAIN_PARSE_EMPTY_SEGMENT'
  | 'CHAIN_PARSE_UNSUPPORTED_OPERATOR'
  | 'CHAIN_PARSE_UNTERMINATED_QUOTE'
  | 'CHAIN_PARSE_TRAILING_ESCAPE'
  | 'GIT_C_INVALID'
  | 'GIT_C_UNSAFE_PATH'
  | 'GIT_C_UNSUPPORTED_SUBCOMMAND'
  | 'COMMAND_NOT_ALLOWLISTED';

type ReadonlyShellValidationFailure = Readonly<{
  reason: ReadonlyShellValidationFailureReason;
  rejectedSegment: string;
}>;

type ReadonlyShellValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; failure: ReadonlyShellValidationFailure }>;

type ReadonlyShellChainParseResult =
  | Readonly<{ ok: true; segments: string[] }>
  | Readonly<{ ok: false; reason: ReadonlyShellValidationFailureReason; rejectedSegment: string }>;

function validateReadonlyShellCommand(command: string): ReadonlyShellValidationResult {
  return validateReadonlyShellCommandInternal(command.trimStart(), 0);
}

function validateReadonlyShellCommandInternal(
  command: string,
  depth: number,
): ReadonlyShellValidationResult {
  if (depth > 8) {
    return {
      ok: false,
      failure: {
        reason: 'MAX_DEPTH',
        rejectedSegment: command.trim() === '' ? command : command.trim(),
      },
    };
  }
  const trimmed = command.trimStart();

  if (trimmed.startsWith('cd ')) {
    const parsed = parseCdChain(trimmed);
    if (!parsed) {
      return { ok: false, failure: { reason: 'INVALID_CD_SYNTAX', rejectedSegment: trimmed } };
    }

    const dir = parsed.dir.replace(/^["']|["']$/g, '');
    if (!isSafeRelativePath(dir)) {
      return {
        ok: false,
        failure: {
          reason: 'UNSAFE_RELATIVE_PATH',
          rejectedSegment: `cd ${parsed.dir}`,
        },
      };
    }

    return validateReadonlyShellCommandInternal(parsed.rest, depth + 1);
  }

  const chainParsed = splitTopLevelReadonlyShellChain(trimmed);
  if (!chainParsed.ok) {
    return {
      ok: false,
      failure: {
        reason: chainParsed.reason,
        rejectedSegment: chainParsed.rejectedSegment,
      },
    };
  }
  if (chainParsed.segments.length > 1) {
    for (const segment of chainParsed.segments) {
      const segmentValidation = validateReadonlyShellCommandInternal(segment, depth + 1);
      if (!segmentValidation.ok) {
        return segmentValidation;
      }
    }
    return { ok: true };
  }

  if (trimmed.startsWith('git -C ')) {
    // Allow a narrow, read-only subset of `git -C <dir> <subcommand> ...` as long as <dir> looks
    // like a safe *relative* path (no absolute paths / parent traversal). This avoids accidentally
    // inspecting outside the rtws with `git -C /...`.
    const tokens = trimmed.split(/\s+/g);
    // Expected: git -C <dir> <subcommand> ...
    if (tokens.length >= 4 && tokens[0] === 'git' && tokens[1] === '-C') {
      const dirRaw = tokens[2] ?? '';
      const dir = dirRaw.replace(/^["']|["']$/g, '');
      const subcommand = tokens[3] ?? '';

      if (!isSafeRelativePath(dir)) {
        return { ok: false, failure: { reason: 'GIT_C_UNSAFE_PATH', rejectedSegment: trimmed } };
      }

      if (
        subcommand === 'show' ||
        subcommand === 'status' ||
        subcommand === 'diff' ||
        subcommand === 'log' ||
        subcommand === 'blame'
      ) {
        return { ok: true };
      }

      return {
        ok: false,
        failure: { reason: 'GIT_C_UNSUPPORTED_SUBCOMMAND', rejectedSegment: trimmed },
      };
    }

    return { ok: false, failure: { reason: 'GIT_C_INVALID', rejectedSegment: trimmed } };
  }

  if (isAllowedReadonlyShellVersionProbe(trimmed)) {
    return { ok: true };
  }

  for (const prefix of readonlyShellAllowedPrefixes) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
      return { ok: true };
    }
  }

  return { ok: false, failure: { reason: 'COMMAND_NOT_ALLOWLISTED', rejectedSegment: trimmed } };
}

function splitTopLevelReadonlyShellChain(command: string): ReadonlyShellChainParseResult {
  const segments: string[] = [];
  let quote: "'" | '"' | null = null;
  let escape = false;
  let segmentStart = 0;

  const pushSegment = (endExclusive: number): boolean => {
    const segment = command.slice(segmentStart, endExclusive).trim();
    if (segment === '') return false;
    segments.push(segment);
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';

    if (escape) {
      escape = false;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"') {
        escape = true;
      }
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    const next = command[i + 1] ?? '';
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (!pushSegment(i)) {
        return {
          ok: false,
          reason: 'CHAIN_PARSE_EMPTY_SEGMENT',
          rejectedSegment: command.trim(),
        };
      }
      i += 1;
      segmentStart = i + 1;
      continue;
    }
    if (ch === '|') {
      if (!pushSegment(i)) {
        return {
          ok: false,
          reason: 'CHAIN_PARSE_EMPTY_SEGMENT',
          rejectedSegment: command.trim(),
        };
      }
      segmentStart = i + 1;
      continue;
    }
    if (ch === ';') {
      return {
        ok: false,
        reason: 'CHAIN_PARSE_UNSUPPORTED_OPERATOR',
        rejectedSegment: command.slice(segmentStart).trim() || command.trim(),
      };
    }
    if (ch === '&') {
      return {
        ok: false,
        reason: 'CHAIN_PARSE_UNSUPPORTED_OPERATOR',
        rejectedSegment: command.slice(segmentStart).trim() || command.trim(),
      };
    }
  }

  if (quote) {
    return {
      ok: false,
      reason: 'CHAIN_PARSE_UNTERMINATED_QUOTE',
      rejectedSegment: command.trim(),
    };
  }
  if (escape) {
    return {
      ok: false,
      reason: 'CHAIN_PARSE_TRAILING_ESCAPE',
      rejectedSegment: command.trim(),
    };
  }
  if (!pushSegment(command.length)) {
    return {
      ok: false,
      reason: 'CHAIN_PARSE_EMPTY_SEGMENT',
      rejectedSegment: command.trim(),
    };
  }
  return { ok: true, segments };
}

function isSafeRelativePath(dir: string): boolean {
  const hasParentTraversal = /(^|[\\/])\.\.([\\/]|$)/.test(dir);
  const isAbsoluteOrHome =
    dir.startsWith('/') ||
    dir.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(dir) ||
    dir.startsWith('\\\\');
  return !isAbsoluteOrHome && !hasParentTraversal && dir.trim() !== '';
}

function parseCdChain(command: string): Readonly<{ dir: string; rest: string }> | null {
  // Supports: cd <dir> && <rest>   or   cd <dir> || <rest>
  // `<dir>` may be single/double-quoted; `<rest>` must be non-empty.
  if (!command.startsWith('cd ')) return null;

  let i = 2;
  while (i < command.length && /\s/.test(command[i] ?? '')) i++;
  if (i >= command.length) return null;

  const start = i;
  const first = command[i] ?? '';
  if (first === '"' || first === "'") {
    const quote = first;
    i++;
    while (i < command.length && command[i] !== quote) i++;
    if (i >= command.length) return null;
    i++; // consume closing quote
  } else {
    while (i < command.length && !/\s/.test(command[i] ?? '')) i++;
  }

  const dir = command.slice(start, i).trim();
  if (dir === '') return null;

  while (i < command.length && /\s/.test(command[i] ?? '')) i++;
  const op = command.slice(i, i + 2);
  if (op !== '&&' && op !== '||') return null;
  i += 2;
  while (i < command.length && /\s/.test(command[i] ?? '')) i++;
  const rest = command.slice(i).trimStart();
  if (rest === '') return null;
  return { dir, rest };
}

type ShellToken = Readonly<{ text: string; quoted: boolean }>;

function splitShellTokens(command: string): ShellToken[] {
  const out: Array<{ text: string; quoted: boolean }> = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  let tokenQuoted = false;

  const push = (): void => {
    if (buf === '') return;
    out.push({ text: buf, quoted: tokenQuoted });
    buf = '';
    tokenQuoted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      buf += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenQuoted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    buf += ch;
  }

  push();
  return out;
}

function firstReadonlyShellToken(segment: string): string {
  const tokens = splitShellTokens(segment.trim());
  return tokens[0]?.text ?? '';
}

function getReadonlyShellSuggestionEn(failure: ReadonlyShellValidationFailure): string {
  const token = firstReadonlyShellToken(failure.rejectedSegment);

  if (
    failure.reason === 'CHAIN_PARSE_UNSUPPORTED_OPERATOR' ||
    failure.reason === 'CHAIN_PARSE_EMPTY_SEGMENT'
  ) {
    return 'Use only `|`, `&&`, `||` for chaining. Example: `ls || true`.';
  }
  if (
    failure.reason === 'CHAIN_PARSE_UNTERMINATED_QUOTE' ||
    failure.reason === 'CHAIN_PARSE_TRAILING_ESCAPE'
  ) {
    return 'Fix shell quoting first, then run an allowlisted segment (for example: `ls` or `rg <pattern>`).';
  }
  if (failure.reason === 'INVALID_CD_SYNTAX' || failure.reason === 'UNSAFE_RELATIVE_PATH') {
    return 'Use `cd <relative-path> && <allowed command...>`.';
  }
  if (
    failure.reason === 'GIT_C_INVALID' ||
    failure.reason === 'GIT_C_UNSAFE_PATH' ||
    failure.reason === 'GIT_C_UNSUPPORTED_SUBCOMMAND'
  ) {
    return 'Use `git -C <relative-path> <show|status|diff|log|blame> ...`.';
  }
  if (failure.reason === 'MAX_DEPTH') {
    return 'Reduce nested chaining depth (for example split into smaller `readonly_shell` calls).';
  }

  if (token === 'node') return 'Only version probes are allowed: `node --version || true`.';
  if (token === 'python3' || token === 'python') {
    return 'Only version probes are allowed: `python3 --version || true`.';
  }
  if (token === 'false') return 'Use `true` as fallback (for example: `ls || true`).';
  if (token === 'git') {
    return 'Use `git <show|status|diff|log|blame> ...` or `git -C <relative-path> <show|status|diff|log|blame> ...`.';
  }
  if (token === 'cd') return 'Use `cd <relative-path> && <allowed command...>`.';

  return 'Use an allowlisted read-only segment (for example: `ls`, `rg <pattern>`, or `git status`).';
}

function getReadonlyShellSuggestionZh(failure: ReadonlyShellValidationFailure): string {
  const token = firstReadonlyShellToken(failure.rejectedSegment);

  if (
    failure.reason === 'CHAIN_PARSE_UNSUPPORTED_OPERATOR' ||
    failure.reason === 'CHAIN_PARSE_EMPTY_SEGMENT'
  ) {
    return '仅使用 `|`、`&&`、`||` 串联；示例：`ls || true`。';
  }
  if (
    failure.reason === 'CHAIN_PARSE_UNTERMINATED_QUOTE' ||
    failure.reason === 'CHAIN_PARSE_TRAILING_ESCAPE'
  ) {
    return '先修正引号/转义，再执行白名单子命令（例如：`ls` 或 `rg <pattern>`）。';
  }
  if (failure.reason === 'INVALID_CD_SYNTAX' || failure.reason === 'UNSAFE_RELATIVE_PATH') {
    return '请使用 `cd <相对路径> && <允许命令...>`。';
  }
  if (
    failure.reason === 'GIT_C_INVALID' ||
    failure.reason === 'GIT_C_UNSAFE_PATH' ||
    failure.reason === 'GIT_C_UNSUPPORTED_SUBCOMMAND'
  ) {
    return '请使用 `git -C <相对路径> <show|status|diff|log|blame> ...`。';
  }
  if (failure.reason === 'MAX_DEPTH') {
    return '请降低链式嵌套深度（可拆成多次 `readonly_shell` 调用）。';
  }

  if (token === 'node') return '仅允许版本探针：`node --version || true`。';
  if (token === 'python3' || token === 'python') {
    return '仅允许版本探针：`python3 --version || true`。';
  }
  if (token === 'false') return '兜底请用 `true`（例如：`ls || true`）。';
  if (token === 'git') {
    return '可改为 `git <show|status|diff|log|blame> ...`，或 `git -C <相对路径> <show|status|diff|log|blame> ...`。';
  }
  if (token === 'cd') return '可改为 `cd <相对路径> && <允许命令...>`。';

  return '请改用白名单只读子命令（例如：`ls`、`rg <pattern>`、`git status`）。';
}

function normalizeRelFromRtwsRoot(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

type ForbiddenHiddenDir = '.minds' | '.dialogs';

function detectForbiddenRtwsRootHiddenDir(relFromRoot: string): ForbiddenHiddenDir | null {
  const normalized = normalizeRelFromRtwsRoot(relFromRoot);
  if (normalized === '.minds' || normalized.startsWith('.minds/')) return '.minds';
  if (normalized === '.dialogs' || normalized.startsWith('.dialogs/')) return '.dialogs';
  return null;
}

function resolveRelFromRtwsRoot(
  workspaceRootAbs: string,
  baseDirRel: string,
  token: string,
): string {
  const abs = path.resolve(workspaceRootAbs, baseDirRel, token);
  return path.relative(workspaceRootAbs, abs);
}

function detectReadonlyShellForbiddenHiddenDirAccess(
  workspaceRootAbs: string,
  command: string,
): ForbiddenHiddenDir | null {
  // Deny access to rtws-root `.minds/**` and `.dialogs/**` only.
  // Nested rtws (e.g. `ux-rtws/.minds/**`, `ux-rtws/.dialogs/**`) remains allowed.
  let baseDirRel = '.';
  let rest = command.trimStart();

  // Evaluate chained `cd ... && ...` prefixes and track base dir.
  while (rest.startsWith('cd ')) {
    const parsed = parseCdChain(rest);
    if (!parsed) break;
    const dir = parsed.dir.replace(/^["']|["']$/g, '');
    const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, dir);
    const forbidden = detectForbiddenRtwsRootHiddenDir(relFromRoot);
    if (forbidden) return forbidden;
    baseDirRel = path.join(baseDirRel, dir);
    rest = parsed.rest.trimStart();
  }

  const tokens = splitShellTokens(rest);
  const cmd = tokens[0]?.text ?? '';
  if (!cmd) return null;

  const tokenText = (i: number): string | null => {
    const v = tokens[i];
    if (!v) return null;
    return v.text;
  };

  // Handle the special allowed form: `git -C <dir> <subcommand> ...`
  if (cmd === 'git' && tokenText(1) === '-C') {
    const dirToken = tokenText(2);
    if (dirToken) {
      const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, dirToken);
      const forbidden = detectForbiddenRtwsRootHiddenDir(relFromRoot);
      if (forbidden) return forbidden;
    }
    return null;
  }

  const checkPathToken = (raw: string): ForbiddenHiddenDir | null => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '--') return null;
    const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, trimmed);
    return detectForbiddenRtwsRootHiddenDir(relFromRoot);
  };

  // Command-specific parsing to avoid false-positives where `.minds` is just a pattern/filter.
  if (cmd === 'rg') {
    // `rg [OPTIONS] PATTERN [PATH ...]`
    let i = 1;
    while (i < tokens.length) {
      const t = tokenText(i);
      if (!t) break;
      if (t === '--') {
        i += 1;
        break;
      }
      if (t.startsWith('-')) {
        i += 1;
        continue;
      }
      // First non-flag token is PATTERN (do not treat as a path).
      i += 1;
      break;
    }
    for (; i < tokens.length; i++) {
      const t = tokenText(i);
      if (!t) continue;
      const forbidden = checkPathToken(t);
      if (forbidden) return forbidden;
    }
    return null;
  }

  if (cmd === 'jq') {
    // `jq [OPTIONS] FILTER [FILE ...]`
    let i = 1;
    while (i < tokens.length) {
      const t = tokenText(i);
      if (!t) break;
      if (t === '--') {
        i += 1;
        break;
      }
      if (t.startsWith('-')) {
        i += 1;
        continue;
      }
      // First non-flag token is FILTER (do not treat as a file path).
      i += 1;
      break;
    }
    for (; i < tokens.length; i++) {
      const t = tokenText(i);
      if (!t) continue;
      const forbidden = checkPathToken(t);
      if (forbidden) return forbidden;
    }
    return null;
  }

  if (cmd === 'find') {
    // `find [path ...] [expression]` — only treat the initial paths as path roots.
    for (let i = 1; i < tokens.length; i++) {
      const t = tokenText(i);
      if (!t) continue;
      if (t.startsWith('-')) break;
      if (t === '!' || t === '(' || t === ')') break;
      const forbidden = checkPathToken(t);
      if (forbidden) return forbidden;
    }
    return null;
  }

  // Default conservative: treat non-flag args as potential paths for common file-inspection commands.
  // This intentionally does NOT block `echo/printf/awk/...` where args are data, not paths.
  const pathLikeCommands = new Set([
    'cat',
    'ls',
    'nl',
    'wc',
    'head',
    'tail',
    'stat',
    'file',
    'diff',
    'realpath',
    'readlink',
    'tree',
    'sed',
  ]);

  if (pathLikeCommands.has(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokenText(i);
      if (!t) continue;
      if (t.startsWith('-')) continue;
      const forbidden = checkPathToken(t);
      if (forbidden) return forbidden;
    }
  }

  return null;
}

export const readonlyShellTool: FuncTool = {
  type: 'func',
  name: 'readonly_shell',
  description:
    'Execute a read-only shell command from a small allowlist. Only exact version probes are allowed for node/python (no scripts such as `node -e` or `python3 -c`). Command chains via |/&&/|| are validated segment-by-segment. Commands outside the allowlist are rejected.',
  descriptionI18n: {
    en: 'Execute a read-only shell command from a small allowlist. Only exact version probes are allowed for node/python (no scripts such as `node -e` or `python3 -c`). Command chains via |/&&/|| are validated segment-by-segment. You are explicitly authorized to call this tool yourself (no delegation). Commands outside the allowlist are rejected.',
    zh: '执行只读 shell 命令，仅允许少量白名单命令前缀。对 node/python 仅允许版本探针（不允许 `node -e` / `python3 -c` 这类脚本）。通过 |/&&/|| 串联时会按子命令逐段校验。你已被明确授权自行调用该工具（无需委派）。不在允许列表内的命令会被拒绝。',
  },
  parameters: readonlyShellSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseReadonlyShellArgs(args);
    const { command, timeoutMs = 10_000 } = parsedArgs;

    if (command.includes('\n') || command.includes('\r')) {
      return toolFailure(
        language === 'zh'
          ? `❌ readonly_shell 不建议执行多行脚本式命令（检测到换行符）。请用单行命令（允许 |、&&、||）。\n收到：${command}`
          : `❌ readonly_shell does not allow multi-line script-style commands (newline detected). Use a single-line command (|, &&, || are allowed).\nGot: ${command}`,
      );
    }

    const validation = validateReadonlyShellCommand(command);
    if (!validation.ok) {
      const allowedList = readonlyShellAllowedPrefixes.join(', ');
      const rejectedSegment = validation.failure.rejectedSegment.trim();
      const rejectedSegmentOrCommand = rejectedSegment === '' ? command : rejectedSegment;
      const suggestion =
        language === 'zh'
          ? getReadonlyShellSuggestionZh(validation.failure)
          : getReadonlyShellSuggestionEn(validation.failure);
      return toolFailure(
        language === 'zh'
          ? `❌ readonly_shell 仅允许以下命令前缀：${allowedList}\n另外允许（仅版本探针）：node --version|-v、python3 --version|-V\n脚本执行（如 node -e / python3 -c）一律拒绝。\n另外允许：git -C <相对路径> <show|status|diff|log|blame> ...\n另外允许：cd <相对路径> && <允许命令...>（或 ||）\n说明：通过 |/&&/|| 串联时会按子命令逐段校验。\n被拒子命令段：${rejectedSegmentOrCommand}\n允许的等价写法：${suggestion}\n收到：${command}`
          : `❌ readonly_shell only allows these command prefixes: ${allowedList}\nAlso allowed (exact version probes only): node --version|-v, python3 --version|-V\nNode/python scripts (for example: node -e, python3 -c) are rejected.\nAlso allowed: git -C <relative-path> <show|status|diff|log|blame> ...\nAlso allowed: cd <relative-path> && <allowed command...> (or ||)\nNote: chains via |/&&/|| are validated segment-by-segment.\nRejected segment: ${rejectedSegmentOrCommand}\nAllowed equivalent: ${suggestion}\nGot: ${command}`,
      );
    }

    const forbiddenHiddenDir = detectReadonlyShellForbiddenHiddenDirAccess(
      path.resolve(process.cwd()),
      command,
    );
    if (forbiddenHiddenDir) {
      if (forbiddenHiddenDir === '.minds') {
        return toolFailure(
          language === 'zh'
            ? `❌ **访问被拒绝**\n\n- 工具：\`readonly_shell\`\n- 路径：\`.minds/\`\n- 代码：\`ACCESS_DENIED\`\n\n说明：\`.minds/\` 是 rtws 根目录下的保留目录，readonly_shell 无条件拒绝访问。\n\n提示：\n- 若团队配置了 \`team_mgmt\` 工具集，请使用其中工具（\`team_mgmt_*\`）代管 \`.minds/**\`。\n- 若团队未配置该工具集或你不具备权限，请诉请具备 \`team_mgmt\` 权限的成员/团队管理员成员代管。\n- 若需要排查 Dominds，请在子目录 rtws 下复现（例如 \`ux-rtws/.dialogs/**\`）。`
            : `❌ **Access Denied**\n\n- Tool: \`readonly_shell\`\n- Path: \`.minds/\`\n- Code: \`ACCESS_DENIED\`\n\nNote: \`.minds/\` is a reserved directory at the rtws root; readonly_shell hard-denies access.\n\nHints:\n- If your team configured the \`team_mgmt\` toolset, use its tools (\`team_mgmt_*\`) to manage \`.minds/**\`.\n- If the toolset is not configured or you don't have permission, tellask a team-admin / a member with \`team_mgmt\` access to manage it for you.\n- For Dominds debugging, reproduce under a nested rtws (e.g. \`ux-rtws/.dialogs/**\`).`,
        );
      }

      return toolFailure(
        language === 'zh'
          ? `❌ **访问被拒绝**\n\n- 工具：\`readonly_shell\`\n- 路径：\`.dialogs/\`\n- 代码：\`ACCESS_DENIED\`\n\n说明：\`.dialogs/\` 是 rtws 根目录下的保留目录，readonly_shell 无条件拒绝访问。\n\n提示：\n- 若需要排查 Dominds，请在子目录 rtws 下复现（例如 \`ux-rtws/.dialogs/**\`）。`
          : `❌ **Access Denied**\n\n- Tool: \`readonly_shell\`\n- Path: \`.dialogs/\`\n- Code: \`ACCESS_DENIED\`\n\nNote: \`.dialogs/\` is a reserved directory at the rtws root; readonly_shell hard-denies access.\n\nHints:\n- For Dominds debugging, reproduce under a nested rtws (e.g. \`ux-rtws/.dialogs/**\`).`,
      );
    }

    const stdoutBuffer = new HeadTailByteBuffer(1024 * 1024);
    const stderrBuffer = new HeadTailByteBuffer(1024 * 1024);

    return new Promise<ToolCallOutput>((resolve) => {
      let settled = false;
      const finish = (output: ToolCallOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      const spawnSpec = resolveReadonlyShellSpawnSpec(command);
      const childProcess = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer.addBytes(data);
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderrBuffer.addBytes(data);
      });

      const timeoutHandle = setTimeout(() => {
        try {
          childProcess.kill('SIGTERM');
        } catch {
          // ignore
        }

        const omittedBytes = stdoutBuffer.getOmittedBytes() + stderrBuffer.getOmittedBytes();

        const fenceConsole = '```console';
        const fenceEnd = '```';
        const timeoutMsg =
          language === 'zh'
            ? `⏱️ 命令超时（${timeoutMs}ms），已发送 SIGTERM。\n`
            : `⏱️ Command timed out (${timeoutMs}ms); SIGTERM sent.\n`;
        const truncationNotice =
          omittedBytes > 0
            ? language === 'zh'
              ? `⚠️  输出已截断，约省略 ${omittedBytes} 字节\n`
              : `⚠️  Output truncated; ~${omittedBytes} bytes omitted\n`
            : '';

        let result = `${timeoutMsg}${truncationNotice}`.trimEnd();

        const stdoutContent = truncateToolOutputText(stdoutBuffer.getContent(), {
          toolName: 'readonly_shell_stdout',
        }).text;
        const stderrContent = truncateToolOutputText(stderrBuffer.getContent(), {
          toolName: 'readonly_shell_stderr',
        }).text;

        if (stdoutContent) {
          result += `\n\n${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}`;
        }

        if (stderrContent) {
          result += `\n\n${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        finish(toolPartialFailure(result.trim()));
      }, timeoutMs);

      childProcess.on('close', (code) => {
        clearTimeout(timeoutHandle);

        const omittedBytes = stdoutBuffer.getOmittedBytes() + stderrBuffer.getOmittedBytes();
        const truncationNotice =
          omittedBytes > 0
            ? language === 'zh'
              ? `\n⚠️  输出已截断，约省略 ${omittedBytes} 字节`
              : `\n⚠️  Output truncated; ~${omittedBytes} bytes omitted`
            : '';

        const stdoutContent = truncateToolOutputText(stdoutBuffer.getContent(), {
          toolName: 'readonly_shell_stdout',
        }).text;
        const stderrContent = truncateToolOutputText(stderrBuffer.getContent(), {
          toolName: 'readonly_shell_stderr',
        }).text;

        const fenceConsole = '```console';
        const fenceEnd = '```';
        let result = t.commandCompleted(code, truncationNotice);

        if (stdoutContent) {
          result += `${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}\n\n`;
        }

        if (stderrContent) {
          result += `${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        finish(code === 0 ? toolSuccess(result.trim()) : toolPartialFailure(result.trim()));
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        finish(toolFailure(t.failedToExecute(error.message)));
      });
    });
  },
};

// Stop daemon tool implementation
export const stopDaemonTool: FuncTool = {
  type: 'func',
  name: 'stop_daemon',
  description:
    'Terminate a running daemon process by PID. Use this after checking daemon output with get_daemon_output when monitoring is complete. Removes the daemon from tracking.',
  descriptionI18n: {
    en: 'Terminate a running daemon process by PID. Use this after checking daemon output with get_daemon_output when monitoring is complete. Removes the daemon from tracking.',
    zh: '根据 PID 终止正在运行的守护进程。通常在使用 get_daemon_output 检查输出并确认无需继续监控后调用。该操作会停止进程并移除追踪。',
  },
  parameters: stopDaemonSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const { pid, entirePg } = parseStopDaemonArgs(args);
    const reminders = await loadAgentSharedReminders(dlg.agentId);
    const reminder = reminders.find(
      (candidate) => isShellCmdReminder(candidate) && candidate.meta.pid === pid,
    );
    if (!reminder || !isShellCmdReminder(reminder)) {
      return toolFailure(t.noDaemonFound(pid));
    }

    try {
      const resolved = await resolveDaemonFromMeta(reminder.meta);
      if (resolved.kind === 'gone') {
        await removeDaemonRemindersForPid(dlg, pid);
        return toolFailure(t.noDaemonFound(pid));
      }
      if (resolved.kind === 'error') {
        return toolFailure(t.failedToStop(pid, resolved.errorText));
      }

      if (
        reminder.meta.runnerEndpoint !== undefined &&
        reminder.meta.runnerEndpoint.trim() !== ''
      ) {
        try {
          const stopResponse = await callRunner(
            reminder.meta.runnerEndpoint,
            { type: 'stop' },
            10_000,
          );
          if (stopResponse.ok && runnerResponseMatchesReminder(reminder.meta, stopResponse)) {
            if (stopResponse.isRunning) {
              await bestEffortKillDaemonProcessGroup(reminder.meta, { includeEntirePg: entirePg });
            }
          } else {
            await removeDaemonRemindersForPid(dlg, pid);
            return toolFailure(t.noDaemonFound(pid));
          }
        } catch {
          await bestEffortKillDaemonProcessGroup(reminder.meta, { includeEntirePg: entirePg });
        }
      } else {
        await bestEffortKillDaemonProcessGroup(reminder.meta, { includeEntirePg: entirePg });
      }

      await removeDaemonRemindersForPid(dlg, pid);
      return toolSuccess(t.daemonStopped(pid, reminder.meta.initialCommandLine));
    } catch (error) {
      return toolFailure(
        t.failedToStop(pid, error instanceof Error ? error.message : String(error)),
      );
    }
  },
};

// Get daemon output tool implementation
export const getDaemonOutputTool: FuncTool = {
  type: 'func',
  name: 'get_daemon_output',
  description:
    'Retrieve captured stdout/stderr output from a tracked daemon process by PID. By default both streams are returned together; you may disable either stream explicitly. Returns (no output) if a requested stream has not produced output yet.',
  descriptionI18n: {
    en: 'Retrieve captured stdout/stderr output from a tracked daemon process by PID. By default both streams are returned together; you may disable either stream explicitly. Returns (no output) if a requested stream has not produced output yet.',
    zh: '根据 PID 获取已追踪守护进程的 stdout/stderr 输出。默认会同时返回两个流，也可显式关闭其中一个；若所请求的流尚无输出，则返回 (no output)。',
  },
  parameters: getDaemonOutputSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const { pid, stdout, stderr } = parseGetDaemonOutputArgs(args);

    const reminders = await loadAgentSharedReminders(dlg.agentId);
    const reminder = reminders.find(
      (candidate) => isShellCmdReminder(candidate) && candidate.meta.pid === pid,
    );
    if (!reminder || !isShellCmdReminder(reminder)) {
      return toolFailure(t.noDaemonFound(pid));
    }

    const resolved = await resolveDaemonFromMeta(reminder.meta);
    if (resolved.kind === 'gone') {
      await removeDaemonRemindersForPid(dlg, pid);
      return toolFailure(t.noDaemonFound(pid));
    }
    if (resolved.kind === 'error') {
      return toolFailure(formatRunnerRecoveryError(pid, resolved.errorText, language));
    }

    const daemon = resolved.daemon;
    let result = '';
    const fenceConsole = '```console';
    const fenceEnd = '```';

    if (stdout) {
      const stdoutContent = truncateToolOutputText(daemon.stdoutContent, {
        toolName: 'get_daemon_output_stdout',
      }).text;
      result += t.daemonOutputHeader(pid, 'stdout');
      result +=
        stdoutContent === '' ? t.noOutput : `${fenceConsole}\n${stdoutContent}\n${fenceEnd}`;
      if (daemon.stdoutLinesScrolledOut > 0) {
        result += t.scrolledOutNotice(daemon.stdoutLinesScrolledOut);
      }
    }

    if (stderr) {
      if (result !== '') {
        result += '\n\n';
      }
      const stderrContent = truncateToolOutputText(daemon.stderrContent, {
        toolName: 'get_daemon_output_stderr',
      }).text;
      result += t.daemonOutputHeader(pid, 'stderr');
      result +=
        stderrContent === '' ? t.noOutput : `${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
      if (daemon.stderrLinesScrolledOut > 0) {
        result += t.scrolledOutNotice(daemon.stderrLinesScrolledOut);
      }
    }

    return toolSuccess(result);
  },
};
