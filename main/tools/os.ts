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
import { domindsRtwsRootAbs } from '../rtws';
import {
  formatAutoMaintainedReminderManualMirrorBan,
  formatSystemNoticePrefix,
} from '../runtime/driver-messages';
import { getWorkLanguage } from '../runtime/work-language';
import { loadSharedReminders, mutateSharedReminders } from '../shared-reminders';
import { Team } from '../team';
import type {
  FuncTool,
  JsonObject,
  JsonSchema,
  JsonValue,
  Reminder,
  ReminderOwner,
  ReminderUpdateResult,
  ReminderWakeEvent,
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
import { bestEffortKillPid, bestEffortKillWindowsProcessTree, sleepMs } from './process-kill';
import { buildCapturedShellEnv } from './shell-capture-env';

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
  windowsVerbatimArguments?: boolean;
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
  const reminders = await loadSharedReminders({ kind: 'agent', agentId });
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
  originRootId?: string;
  completed?: boolean;
  lastUpdated?: string;
  stdoutDigestSha256?: string;
  stdoutLinesScrolledOut?: number;
  stderrDigestSha256?: string;
  stderrLinesScrolledOut?: number;
  recoveryErrorText?: string;
  exitWakeEventId?: string;
  exitWakeNotifiedAt?: string;
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
  if (previousMeta.originRootId !== undefined) {
    nextMeta['originRootId'] = previousMeta.originRootId;
  }
  if (daemon.processGroupId !== undefined) {
    nextMeta['processGroupId'] = daemon.processGroupId;
  }
  if (previousMeta.exitWakeEventId !== undefined) {
    nextMeta['exitWakeEventId'] = previousMeta.exitWakeEventId;
  }
  if (previousMeta.exitWakeNotifiedAt !== undefined) {
    nextMeta['exitWakeNotifiedAt'] = previousMeta.exitWakeNotifiedAt;
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

type DaemonLifecyclePhase = 'running' | 'exited';

function formatDaemonLifecyclePhaseSummary(
  command: string,
  phase: DaemonLifecyclePhase,
  language: LanguageCode,
): string {
  if (language === 'zh') {
    return phase === 'running'
      ? `🟢 ${command} 运行中（系统维护 / 实时真源）`
      : `🟡 ${command} 已退出（退出事件提示）`;
  }
  return phase === 'running'
    ? `🟢 ${command} running (system-maintained / live source of truth)`
    : `🟡 ${command} exited (exit event notice)`;
}

function formatExitedDaemonReminderContent(
  command: string,
  pid: number,
  language: LanguageCode,
  lastKnownSnapshot: string,
): string {
  const phaseSummary = formatDaemonLifecyclePhaseSummary(command, 'exited', language);
  return language === 'zh'
    ? `${phaseSummary}

以下保留最后一次已知 stdout/stderr 快照；该提醒项只表达 daemon 终态，不是当前轮必须立即处理的动作。

最后一次已知状态快照：
${lastKnownSnapshot}`
    : `${phaseSummary}

The last known stdout/stderr snapshot is retained below; this reminder only represents the daemon terminal state, not an action I must perform immediately in this turn.

Last known status snapshot:
${lastKnownSnapshot}`;
}

function stripDaemonLifecyclePhaseSummary(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('🟢 ') && !normalized.startsWith('🟡 ')) {
    return content;
  }
  const separatorIndex = normalized.indexOf('\n\n');
  if (separatorIndex === -1) {
    return content;
  }
  return normalized.slice(separatorIndex + 2);
}

function buildShellCmdExitWakeEventId(meta: ShellCmdReminderMeta): string {
  return `shellCmd:daemonExited:${String(meta.pid)}:${meta.startTime}`;
}

function buildShellCmdExitWakeMeta(
  meta: JsonObject,
  eventId: string,
  notifiedAt: string,
): JsonObject {
  return {
    ...meta,
    exitWakeEventId: eventId,
    exitWakeNotifiedAt: notifiedAt,
  };
}

function assertShellCmdExitWakeNotPreviouslyDelivered(
  meta: ShellCmdReminderMeta,
  eventId: string,
): void {
  if (meta.exitWakeEventId !== undefined && meta.exitWakeEventId !== eventId) {
    throw new Error(
      `shell_cmd daemon wake invariant violation: conflicting exit wake event id for pid ${String(meta.pid)}`,
    );
  }
  if (meta.exitWakeNotifiedAt !== undefined) {
    throw new Error(
      `shell_cmd daemon wake invariant violation: exit wake event already delivered for pid ${String(meta.pid)}`,
    );
  }
}

function assertShellCmdExitWakeDeliveryFieldsConsistent(
  meta: ShellCmdReminderMeta,
  eventId: string,
): void {
  if (meta.exitWakeNotifiedAt !== undefined && meta.exitWakeEventId === undefined) {
    throw new Error(
      `shell_cmd daemon wake invariant violation: exit wake notified timestamp without event id for pid ${String(meta.pid)}`,
    );
  }
  if (meta.exitWakeEventId !== undefined && meta.exitWakeEventId !== eventId) {
    throw new Error(
      `shell_cmd daemon wake invariant violation: delivered event id mismatch for pid ${String(meta.pid)}`,
    );
  }
}

function formatShellCmdDaemonExitWakeContent(args: {
  command: string;
  pid: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  language: LanguageCode;
}): string {
  const prefix = formatSystemNoticePrefix(args.language);
  const status =
    args.exitCode !== undefined || args.exitSignal !== undefined
      ? `code ${String(args.exitCode ?? 'null')}, signal ${String(args.exitSignal ?? 'null')}`
      : args.language === 'zh'
        ? '未知（runner 已不可用）'
        : 'unknown (runner unavailable)';
  return args.language === 'zh'
    ? `${prefix}
后台进程已退出。这是 runtime 环境事件，不是新的用户指令。

- PID: ${String(args.pid)}
- 命令: ${args.command}
- 退出状态: ${status}

请根据当前任务上下文判断是否需要查看最终 stdout/stderr 或向用户汇报结果；不要只回复“收到”。`
    : `${prefix}
A background process has exited. This is a runtime environment event, not a new user instruction.

- PID: ${String(args.pid)}
- Command: ${args.command}
- Exit status: ${status}

Decide from the current task context whether you need to inspect final stdout/stderr or report the result to the user; do not reply with a standalone acknowledgement.`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timeout: NodeJS.Timeout;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      finish();
    };
    timeout = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForShellCmdReminderWakeEvent(
  reminder: ShellCmdOwnedReminder,
  signal: AbortSignal,
): Promise<ReminderWakeEvent | null> {
  const eventId = buildShellCmdExitWakeEventId(reminder.meta);
  assertShellCmdExitWakeDeliveryFieldsConsistent(reminder.meta, eventId);
  if (reminder.meta.completed === true) {
    return null;
  }
  if (reminder.meta.exitWakeNotifiedAt !== undefined) {
    return null;
  }

  while (!signal.aborted) {
    const resolved = await resolveDaemonFromMeta(reminder.meta);
    const notifiedAt = formatUnifiedTimestamp(new Date());
    const language = getWorkLanguage();

    if (resolved.kind === 'gone') {
      const isTrackedDaemon =
        reminder.meta.runnerEndpoint !== undefined || reminder.meta.runnerPid !== undefined;
      if (!isTrackedDaemon) return null;
      assertShellCmdExitWakeNotPreviouslyDelivered(reminder.meta, eventId);
      const updatedMeta = buildShellCmdExitWakeMeta(
        buildShellCmdFinalizedMeta(reminder.meta, notifiedAt),
        eventId,
        notifiedAt,
      );
      const updatedContent = formatExitedDaemonReminderContent(
        reminder.meta.initialCommandLine,
        reminder.meta.pid,
        language,
        stripDaemonLifecyclePhaseSummary(reminder.content),
      );
      return {
        eventId,
        reminderId: reminder.id,
        content: formatShellCmdDaemonExitWakeContent({
          command: reminder.meta.initialCommandLine,
          pid: reminder.meta.pid,
          language,
        }),
        updatedContent,
        updatedMeta,
      };
    }

    if (resolved.kind === 'error') {
      throw new Error(resolved.errorText);
    }

    const daemon = resolved.daemon;
    if (!daemon.isRunning) {
      assertShellCmdExitWakeNotPreviouslyDelivered(reminder.meta, eventId);
      const updatedContent = formatExitedDaemonReminderContent(
        daemon.command,
        reminder.meta.pid,
        language,
        formatRunnerBackedDaemonStatusDetails(daemon, language),
      );
      const completedMeta = buildShellCmdReminderMeta(reminder.meta, daemon, {
        completed: true,
        lastUpdated: notifiedAt,
      });
      return {
        eventId,
        reminderId: reminder.id,
        content: formatShellCmdDaemonExitWakeContent({
          command: daemon.command,
          pid: reminder.meta.pid,
          exitCode: daemon.exitCode,
          exitSignal: daemon.exitSignal,
          language,
        }),
        updatedContent,
        updatedMeta: buildShellCmdExitWakeMeta(completedMeta, eventId, notifiedAt),
      };
    }

    await abortableDelay(1_000, signal);
  }

  return null;
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
      daemonStarted: (pid, timeoutSeconds, command) =>
        `🟢 ${command} 已转入后台持续运行（PID: ${pid}）\n该进程在 ${timeoutSeconds} 秒内未完成，现已作为守护进程继续执行。你将看到同一条生命周期提醒持续刷新：系统维护 / 实时真源。${formatAutoMaintainedReminderManualMirrorBan(language)}\n\n这条结果只说明进程已转入后台；对应 daemon reminder 的维护参考会描述后续管理通道。`,
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
    daemonStarted: (pid, timeoutSeconds, command) =>
      `🟢 ${command} is now running in the background (PID: ${pid})\nThe process did not finish within ${timeoutSeconds} seconds and has transitioned into a daemon. You will see the same lifecycle reminder keep updating: system-maintained / live source of truth. ${formatAutoMaintainedReminderManualMirrorBan(language)}\n\nThis result only reports that the process moved into the background; the corresponding daemon reminder maintenance reference describes later management paths.`,
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
  warning: string | undefined,
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
  const content = prependShellWarning(result.trim(), warning);
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
  await mutateSharedReminders({ kind: 'agent', agentId: dlg.agentId }, (reminders) => {
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

  return {
    pid,
    entirePg: entirePg ?? true,
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

function getWindowsShellLabel(shell: string | undefined): string {
  if (typeof shell !== 'string') {
    return 'cmd.exe';
  }
  const trimmed = shell.trim();
  return trimmed === '' ? 'cmd.exe' : trimmed;
}

function detectWindowsShellUsageWarning(
  command: string,
  shell: string | undefined,
  language: LanguageCode,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') {
    return undefined;
  }

  const trimmedCommand = command.trimStart();
  const nestedCmd = /^cmd(?:\.exe)?\s+(?:\/d\s+)?(?:\/s\s+)?\/c\b/iu.test(trimmedCommand);
  const nestedPowerShell =
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*(?:-|\/)(?:Command|c)\b/iu.test(
      trimmedCommand,
    );
  if (!nestedCmd && !nestedPowerShell) {
    return undefined;
  }

  const shellLabel = getWindowsShellLabel(shell);
  if (language === 'zh') {
    return nestedCmd
      ? `⚠️ 检测到嵌套 shell 写法：${trimmedCommand.startsWith('cmd.exe') ? 'cmd.exe /c' : 'cmd /c'}。shell 参数只负责选择外层执行环境；请直接传入 cmd 原生命令，不要再套一层 cmd /c。当前 shell：${shellLabel}`
      : `⚠️ 检测到嵌套 shell 写法：${trimmedCommand.startsWith('pwsh') ? 'pwsh -Command' : 'powershell -Command'}。shell 参数只负责选择外层执行环境；请直接传入 PowerShell 原生命令，不要再套一层 -Command。当前 shell：${shellLabel}`;
  }

  return nestedCmd
    ? `⚠️ Nested shell syntax detected: ${trimmedCommand.startsWith('cmd.exe') ? 'cmd.exe /c' : 'cmd /c'}. The shell parameter selects the outer execution environment only; pass a native cmd command and do not add another cmd /c layer. Current shell: ${shellLabel}`
    : `⚠️ Nested shell syntax detected: ${trimmedCommand.startsWith('pwsh') ? 'pwsh -Command' : 'powershell -Command'}. The shell parameter selects the outer execution environment only; pass a native PowerShell command and do not add another -Command wrapper. Current shell: ${shellLabel}`;
}

function prependShellWarning(content: string, warning: string | undefined): string {
  if (!warning) {
    return content;
  }
  return `${warning}\n\n${content}`;
}

function formatShellExecutionError(
  shell: string | undefined,
  message: string,
  language: LanguageCode,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || typeof shell !== 'string') {
    return message;
  }

  const base = path.basename(shell.trim()).toLowerCase();
  const missingPid = message.includes('cmd_runner failed to spawn daemon command: missing pid');
  const notFound = /\bENOENT\b|not found|cannot find/i.test(message);
  if ((base !== 'pwsh' && base !== 'pwsh.exe') || (!missingPid && !notFound)) {
    return message;
  }

  return language === 'zh'
    ? '指定的 shell 为 pwsh (PowerShell 7+)，但系统未找到 pwsh 可执行文件。powershell.exe 是 Windows PowerShell 5.1，不等同于 pwsh。'
    : 'The selected shell is pwsh (PowerShell 7+), but the pwsh executable was not found. powershell.exe is Windows PowerShell 5.1 and is not the same shell as pwsh.';
}

function resolveShellCmdSpawnSpec(
  command: string,
  shell: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellSpawnSpec {
  const preferredShell =
    typeof shell === 'string' && shell.trim() !== '' ? shell.trim() : undefined;
  if (platform === 'win32') {
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
          args: ['/d', '/c', command],
          shellLabel: preferredShell,
          windowsVerbatimArguments: true,
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
      args: ['/d', '/c', command],
      shellLabel: 'cmd.exe',
      windowsVerbatimArguments: true,
    };
  }

  const resolvedShell = preferredShell ?? 'bash';
  return {
    command: resolvedShell,
    args: ['-c', command],
    shellLabel: resolvedShell,
  };
}

export function resolveShellCmdSpawnSpecForTests(
  command: string,
  shell: string | undefined,
  platform: NodeJS.Platform,
): ShellSpawnSpec {
  return resolveShellCmdSpawnSpec(command, shell, platform);
}

export function detectWindowsShellUsageWarningForTests(
  command: string,
  shell: string | undefined,
  language: LanguageCode,
  platform: NodeJS.Platform,
): string | undefined {
  return detectWindowsShellUsageWarning(command, shell, language, platform);
}

export function formatShellExecutionErrorForTests(
  shell: string | undefined,
  message: string,
  language: LanguageCode,
  platform: NodeJS.Platform,
): string {
  return formatShellExecutionError(shell, message, language, platform);
}

function resolveReadonlyShellSpawnSpec(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellSpawnSpec {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', command],
      shellLabel: 'cmd.exe',
      windowsVerbatimArguments: true,
    };
  }
  return { command: 'bash', args: ['-c', command], shellLabel: 'bash' };
}

export function resolveReadonlyShellSpawnSpecForTests(
  command: string,
  platform: NodeJS.Platform,
): ShellSpawnSpec {
  return resolveReadonlyShellSpawnSpec(command, platform);
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
  if (includeEntirePg && process.platform === 'win32') {
    await bestEffortKillWindowsProcessTree(meta.pid);
    if (meta.runnerPid !== undefined && meta.runnerPid !== meta.pid) {
      bestEffortKillPid(meta.runnerPid);
    }
    return;
  }
  if (includeEntirePg && process.platform !== 'win32' && meta.processGroupId !== undefined) {
    try {
      process.kill(-meta.processGroupId, 'SIGTERM');
    } catch {
      // Best effort only.
    }
    await sleepMs(1_000);
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
  await sleepMs(250);
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

function formatRunnerBackedDaemonStatusDetails(
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

stderr 缓冲区快照：
${fenceConsole}
${stderrContent}
${fenceEnd}

stdout 缓冲区快照：
${fenceConsole}
${stdoutContent}
${fenceEnd}`
    : `Daemon PID: ${daemon.pid}
Command: ${daemon.command}
Shell: ${daemon.shell}
Lifecycle status: ${status}
Uptime: ${uptime}s
Started at: ${formatUnifiedTimestamp(daemon.startTime)}${stdoutNotice}${stderrNotice}

Stderr buffer snapshot:
${fenceConsole}
${stderrContent}
${fenceEnd}

Stdout buffer snapshot:
${fenceConsole}
${stdoutContent}
${fenceEnd}`;
}

function formatRunnerBackedDaemonStatus(
  daemon: RunnerBackedDaemon,
  language: LanguageCode,
): string {
  const phaseSummary = formatDaemonLifecyclePhaseSummary(daemon.command, 'running', language);
  return `${phaseSummary}

${formatRunnerBackedDaemonStatusDetails(daemon, language)}`;
}

function formatRunnerRecoveryError(pid: number, errorText: string, language: LanguageCode): string {
  return language === 'zh'
    ? `⚠️ 守护进程 ${pid} 的 runner 恢复失败：${errorText}\n这是系统维护的后台进程状态。${formatAutoMaintainedReminderManualMirrorBan(language)}`
    : `⚠️ Failed to recover runner for daemon ${pid}: ${errorText}\nThis is system-maintained background-process state. ${formatAutoMaintainedReminderManualMirrorBan(language)}`;
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
      description:
        'Shell to use for execution (default: bash on Linux/macOS; cmd.exe on Windows). On Windows, choose cmd.exe, powershell.exe, or pwsh explicitly; command must be native to the selected shell.',
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
        'Read-only shell command (common allowed prefixes: cat, rg, sed, ls, nl, wc, head, tail, stat, file, uname, whoami, id, echo, pwd, which, date, diff, realpath, readlink, printf, cut, sort, uniq, tr, awk, shasum, sha256sum, md5sum, uuid, git show, git status, git diff, git log, git blame, find, tree, jq, true; Windows also allows: where, fc, findstr, dir, type, more, ver; exact version probes: node --version|-v, python3/python/py --version|-V; also allows: git -C <relative-path> <show|status|diff|log|blame> ...; also allows: cd <relative-path> && <allowed command...> (or ||); command chains via |/&&/|| are validated segment-by-segment)',
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
        'Whether to stop the entire process group/process tree instead of only the tracked PID (default: true)',
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

stderr 缓冲区快照：
${fenceConsole}
${stderrContent}
${fenceEnd}

stdout 缓冲区快照：
${fenceConsole}
${stdoutContent}
${fenceEnd}`
    : `Daemon PID: ${daemon.pid}
Command: ${daemon.command}
Shell: ${daemon.shell}
Lifecycle status: ${status}
Uptime: ${uptime}s
Started at: ${formatUnifiedTimestamp(daemon.startTime)}${scrollNotice}

Stderr buffer snapshot:
${fenceConsole}
${stderrContent}
${fenceEnd}

Stdout buffer snapshot:
${fenceConsole}
${stdoutContent}
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
        updatedContent: formatExitedDaemonReminderContent(
          reminder.meta.initialCommandLine,
          pid,
          getWorkLanguage(),
          stripDaemonLifecyclePhaseSummary(reminder.content),
        ),
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
        daemon.command,
        pid,
        getWorkLanguage(),
        formatRunnerBackedDaemonStatusDetails(daemon, getWorkLanguage()),
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

  async waitForReminderWakeEvent(
    _dlg: Dialog,
    reminders: readonly Reminder[],
    signal: AbortSignal,
  ): Promise<ReminderWakeEvent | readonly ReminderWakeEvent[] | null> {
    const candidates = reminders.filter(isShellCmdReminder);
    if (candidates.length === 0) return null;
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      controller.abort();
    }
    const pending = candidates.map((reminder) =>
      waitForShellCmdReminderWakeEvent(reminder, controller.signal),
    );
    return await new Promise<ReminderWakeEvent | null>((resolve, reject) => {
      let settled = false;
      let remaining = pending.length;
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        controller.abort();
      };
      const finish = (event: ReminderWakeEvent | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(event);
      };
      const settleEmpty = (): void => {
        if (settled) return;
        remaining -= 1;
        if (remaining === 0) finish(null);
      };
      for (const promise of pending) {
        void promise
          .then((event) => {
            if (event !== null) {
              finish(event);
              return;
            }
            settleEmpty();
          })
          .catch((error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      }
    });
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
            ? `${prefix} 后台进程生命周期提醒 [${reminder.id}]
当前运行环境中有一条系统维护的后台进程状态提醒。请把它当成环境信号，不要当成你自己写的工作便签。
${formatAutoMaintainedReminderManualMirrorBan(language)}
若它没有实质改变你的判断/计划/风险，则禁止做任何用户可见回应（禁止写“静默吸收”“已收到”等占位语句）；只有它实际影响后续动作时，才在下一条有实质内容的回复中体现相关事实。该提醒在进程运行期间会自动更新；进程结束后会保留终态作为运行时上下文。
---
${reminder.content}`
            : `${prefix} Background process lifecycle reminder [${reminder.id}]
The current runtime environment has a system-maintained background-process state reminder. Treat it as an environment signal, not as your self-authored work note. ${formatAutoMaintainedReminderManualMirrorBan(language)} If it does not materially change your judgment/plan/risk, make no user-visible reply at all (do not send filler like "silently noted" or "received"); only reflect it inside the next substantive reply when it actually affects the next action. This reminder auto-updates while the process is running; after exit it keeps the terminal state as runtime context.
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
        const exitedSummary = formatDaemonLifecyclePhaseSummary(
          reminder.meta.initialCommandLine,
          'exited',
          language,
        );
        return {
          type: 'environment_msg',
          role: 'user',
          content:
            language === 'zh'
              ? `${prefix} 守护进程生命周期提醒 [${reminder.id}] - ${exitedSummary}｜PID ${pid}
当前运行环境中 daemon 已退出。
${formatAutoMaintainedReminderManualMirrorBan(language)}
以下是最后一次已知 stdout/stderr 快照；该提醒项只表达 daemon 终态，不是当前轮必须立即处理的动作。
---
${reminder.content}`
              : `${prefix} Daemon lifecycle reminder [${reminder.id}] - ${exitedSummary} | PID ${pid}
The current runtime environment shows that this daemon has exited. ${formatAutoMaintainedReminderManualMirrorBan(language)} The last known stdout/stderr snapshot is retained below; this reminder only represents the daemon terminal state, not an action I must perform immediately in this turn.
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
当前运行环境中该后台进程的生命周期已经结束，当前不再运行。${formatAutoMaintainedReminderManualMirrorBan(language)}`
            : `${prefix} Process lifecycle reminder [${reminder.id}] - daemon terminated (PID ${pid})
The current runtime environment shows that this daemon process has finished its lifecycle and is no longer running. ${formatAutoMaintainedReminderManualMirrorBan(language)}`,
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

    const statusInfo = formatRunnerBackedDaemonStatusDetails(daemon, language);
    const runningSummary = formatDaemonLifecyclePhaseSummary(daemon.command, 'running', language);

    return {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `🔄 ${prefix} 守护进程生命周期提醒 [${reminder.id}] - ${runningSummary}｜PID ${pid}，已运行 ${uptimeStr}
当前运行环境中 daemon 仍在运行。这是系统维护的状态提醒，不是默认需要单独汇报的事项。
${formatAutoMaintainedReminderManualMirrorBan(language)}
若下面的信息没有实质改变你的判断、计划或风险，则禁止做任何用户可见回应；若它有实质影响，只在下一条有实质内容的回复中体现，禁止单独发送“静默吸收”“已收到”等占位语句。

**状态快照：**
${statusInfo}`
          : `🔄 ${prefix} Daemon lifecycle reminder [${reminder.id}] - ${runningSummary} | PID ${pid}, uptime: ${uptimeStr}
The current runtime environment shows that this daemon is still running. This is a system-maintained state reminder and not something that normally deserves a standalone mention. ${formatAutoMaintainedReminderManualMirrorBan(language)} If the information below does not materially change your judgment, plan, or risk, make no user-visible reply at all; if it does matter, reflect it only inside the next substantive reply instead of sending filler like "silently noted" or "received".

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
    'Execute shell commands with optional timeout. If timeoutSeconds > 0 and command runs longer, it becomes a tracked daemon process. On Windows, use shell to choose cmd.exe, powershell.exe, or pwsh, and pass a command that is native to that shell. Do not nest cmd /c or powershell -Command inside another shell command. Daemons persist across messages and require explicit stop_daemon or get_daemon_output calls.',
  descriptionI18n: {
    en: 'Execute shell commands with optional timeout. If timeoutSeconds > 0 and command runs longer, it becomes a tracked daemon process. On Windows, use shell to choose cmd.exe, powershell.exe, or pwsh, and pass a command that is native to that shell. Do not nest cmd /c or powershell -Command inside another shell command. Daemons persist across messages and require explicit stop_daemon or get_daemon_output calls.',
    zh: '执行 shell 命令（支持超时）。如果 timeoutSeconds > 0 且命令运行时间超过超时，将转为可追踪的后台守护进程。Windows 上请用 shell 明确选择 cmd.exe、powershell.exe 或 pwsh，并传入该 shell 的原生命令。不要在另一个 shell 命令里再嵌套 cmd /c 或 powershell -Command。守护进程会跨消息持续存在，需要显式调用 stop_daemon 或 get_daemon_output 来管理与查看输出。',
  },
  parameters: shellCmdSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseShellCmdArgs(args);
    const { command, shell, scrollbackLines = 500, timeoutSeconds = 5 } = parsedArgs;
    const spawnSpec = resolveShellCmdSpawnSpec(command, shell);
    const warning = detectWindowsShellUsageWarning(command, shell, language);
    try {
      const { runnerProcess, initialMessage } = await spawnCmdRunner({
        type: 'init',
        initialCommandLine: command,
        spawnSpec: {
          command: spawnSpec.command,
          args: spawnSpec.args,
          shellLabel: spawnSpec.shellLabel,
          ...(spawnSpec.windowsVerbatimArguments === true
            ? { windowsVerbatimArguments: true }
            : {}),
        },
        timeoutSeconds,
        scrollbackLines,
      });

      if (initialMessage.type === 'completed') {
        return formatCompletedShellCommandOutput(initialMessage, t, warning);
      }

      if (initialMessage.type === 'failed') {
        disconnectRunnerProcess(runnerProcess);
        return toolFailure(
          prependShellWarning(t.failedToExecute(initialMessage.errorText), warning),
        );
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
        originRootId: dlg.id.rootId,
      };
      if (initialMessage.processGroupId !== undefined) {
        reminderSeedMeta.processGroupId = initialMessage.processGroupId;
      }
      const reminderMeta = buildShellCmdReminderMeta(reminderSeedMeta, daemon);
      const reminder = materializeReminder({
        content: `[Daemon PID ${initialMessage.daemonPid} - This content should not be visible, check dynamic rendering]`,
        owner: shellCmdReminderOwner,
        meta: reminderMeta,
        scope: 'runtime',
        renderMode: 'markdown',
      });
      try {
        await mutateSharedReminders({ kind: 'agent', agentId: dlg.agentId }, (reminders) => {
          reminders.push(reminder);
        });
        dlg.touchReminders();
      } catch (error: unknown) {
        await bestEffortKillDaemonProcessGroup(reminderSeedMeta);
        disconnectRunnerProcess(runnerProcess);
        return toolFailure(
          prependShellWarning(
            t.failedToExecute(
              error instanceof Error
                ? `daemon reminder persistence failed: ${error.message}`
                : `daemon reminder persistence failed: ${String(error)}`,
            ),
            warning,
          ),
        );
      }
      disconnectRunnerProcess(runnerProcess);
      return toolSuccess(
        prependShellWarning(
          t.daemonStarted(initialMessage.daemonPid, timeoutSeconds, command),
          warning,
        ),
      );
    } catch (error: unknown) {
      return toolFailure(
        prependShellWarning(
          t.failedToExecute(
            formatShellExecutionError(
              shell,
              error instanceof Error ? error.message : String(error),
              language,
            ),
          ),
          warning,
        ),
      );
    }
  },
};

const readonlyShellCommonAllowedPrefixes = [
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

const readonlyShellWindowsAllowedPrefixes = [
  'where',
  'fc',
  'findstr',
  'dir',
  'type',
  'more',
  'ver',
] as const;

function getReadonlyShellAllowedPrefixes(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === 'win32') {
    return [...readonlyShellCommonAllowedPrefixes, ...readonlyShellWindowsAllowedPrefixes];
  }
  return readonlyShellCommonAllowedPrefixes;
}

function isAllowedReadonlyShellVersionProbe(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const tokens = splitShellTokens(command, platform);
  if (tokens.length !== 2) return false;

  const cmdRaw = tokens[0]?.text ?? '';
  const cmd = platform === 'win32' ? cmdRaw.toLowerCase() : cmdRaw;
  const flag = tokens[1]?.text ?? '';

  if (cmd === 'node') return flag === '--version' || flag === '-v';
  if (cmd === 'python3' || cmd === 'python' || cmd === 'py') {
    return flag === '--version' || flag === '-V';
  }
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
  | 'UNSAFE_SHELL_SYNTAX'
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

function validateReadonlyShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyShellValidationResult {
  return validateReadonlyShellCommandInternal(command.trimStart(), platform, 0);
}

export function validateReadonlyShellCommandForTests(
  command: string,
  platform: NodeJS.Platform,
): ReadonlyShellValidationResult {
  return validateReadonlyShellCommand(command, platform);
}

function validateReadonlyShellCommandInternal(
  command: string,
  platform: NodeJS.Platform,
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

  if (startsWithReadonlyShellCommand(trimmed, 'cd', platform)) {
    const parsed = parseCdChain(trimmed, platform);
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

    return validateReadonlyShellCommandInternal(parsed.rest, platform, depth + 1);
  }

  const chainParsed = splitTopLevelReadonlyShellChain(trimmed, platform);
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
      const segmentValidation = validateReadonlyShellCommandInternal(segment, platform, depth + 1);
      if (!segmentValidation.ok) {
        return segmentValidation;
      }
    }
    return { ok: true };
  }

  if (startsWithReadonlyShellCommand(trimmed, 'git', platform) && /^git\s+-C\s+/iu.test(trimmed)) {
    // Allow a narrow, read-only subset of `git -C <dir> <subcommand> ...` as long as <dir> looks
    // like a safe *relative* path (no absolute paths / parent traversal). This avoids accidentally
    // inspecting outside the rtws with `git -C /...`.
    const tokens = trimmed.split(/\s+/g);
    // Expected: git -C <dir> <subcommand> ...
    const gitCommand = tokens[0] ?? '';
    const gitFlag = tokens[1] ?? '';
    const isGitCommand =
      platform === 'win32' ? gitCommand.toLowerCase() === 'git' : gitCommand === 'git';
    if (tokens.length >= 4 && isGitCommand && gitFlag === '-C') {
      const dirRaw = tokens[2] ?? '';
      const dir = dirRaw.replace(/^["']|["']$/g, '');
      const subcommandRaw = tokens[3] ?? '';
      const subcommand = platform === 'win32' ? subcommandRaw.toLowerCase() : subcommandRaw;

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
        if (hasUnsafeReadonlyShellCommandOptions(trimmed, platform)) {
          return {
            ok: false,
            failure: { reason: 'UNSAFE_SHELL_SYNTAX', rejectedSegment: trimmed },
          };
        }
        return { ok: true };
      }

      return {
        ok: false,
        failure: { reason: 'GIT_C_UNSUPPORTED_SUBCOMMAND', rejectedSegment: trimmed },
      };
    }

    return { ok: false, failure: { reason: 'GIT_C_INVALID', rejectedSegment: trimmed } };
  }

  if (isAllowedReadonlyShellVersionProbe(trimmed, platform)) {
    return { ok: true };
  }

  for (const prefix of getReadonlyShellAllowedPrefixes(platform)) {
    if (matchesReadonlyShellPrefix(trimmed, prefix, platform)) {
      if (hasUnsafeReadonlyShellCommandOptions(trimmed, platform)) {
        return {
          ok: false,
          failure: { reason: 'UNSAFE_SHELL_SYNTAX', rejectedSegment: trimmed },
        };
      }
      return { ok: true };
    }
  }

  return { ok: false, failure: { reason: 'COMMAND_NOT_ALLOWLISTED', rejectedSegment: trimmed } };
}

function hasUnsafeReadonlyShellCommandOptions(command: string, platform: NodeJS.Platform): boolean {
  const tokens = splitShellTokens(command, platform);
  const cmdRaw = tokens[0]?.text ?? '';
  const cmd = platform === 'win32' ? cmdRaw.toLowerCase() : cmdRaw;
  const args = tokens.slice(1).map((token) => token.text);

  if (cmd === 'awk') {
    return args.some(
      (arg) =>
        /\bsystem\s*\(/.test(arg) ||
        arg.includes('>') ||
        arg.includes('|') ||
        arg === '-i' ||
        arg.startsWith('-i') ||
        arg === '--include' ||
        arg.startsWith('--include=') ||
        arg === '-l' ||
        arg.startsWith('-l') ||
        arg === '--load' ||
        arg.startsWith('--load='),
    );
  }
  if (cmd === 'sed') {
    return args.some(
      (arg) =>
        arg === '-i' ||
        arg.startsWith('-i') ||
        arg === '--in-place' ||
        arg.startsWith('--in-place=') ||
        looksLikeSedWriteScript(arg),
    );
  }
  if (cmd === 'find') {
    return args.some((arg) =>
      [
        '-delete',
        '-exec',
        '-execdir',
        '-ok',
        '-okdir',
        '-fprint',
        '-fprint0',
        '-fprintf',
        '-fls',
      ].includes(arg),
    );
  }
  if (cmd === 'git') {
    return args.some(
      (arg) =>
        arg === '-c' ||
        arg === '--config-env' ||
        arg.startsWith('--config-env=') ||
        arg === '--exec-path' ||
        arg.startsWith('--exec-path=') ||
        arg === '--paginate' ||
        arg === '--output' ||
        arg.startsWith('--output=') ||
        arg === '--ext-diff' ||
        arg === '--external-diff' ||
        arg === '--textconv',
    );
  }
  if (cmd === 'sort') {
    return args.some((arg) => arg === '-o' || arg.startsWith('-o') || arg.startsWith('--output'));
  }
  if (cmd === 'rg') {
    return args.some(
      (arg) =>
        arg === '--pre' ||
        arg.startsWith('--pre=') ||
        arg === '--hostname-bin' ||
        arg.startsWith('--hostname-bin='),
    );
  }
  if (cmd === 'date') {
    return args.some(
      (arg) => arg === '-s' || arg.startsWith('-s') || arg === '--set' || arg.startsWith('--set='),
    );
  }

  return false;
}

function looksLikeSedWriteScript(script: string): boolean {
  const commandParts = script.split(/[;{}]/g);
  return commandParts.some(
    (part) =>
      /^\s*(?:[0-9,$!+~\/\\-]+|\/(?:\\.|[^/])*\/)?w(?:\s|$)/.test(part) ||
      /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9gIpMew]*w/.test(part),
  );
}

function splitTopLevelReadonlyShellChain(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyShellChainParseResult {
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
    const next = command[i + 1] ?? '';

    if (escape) {
      escape = false;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (
        quote === '"' &&
        (ch === '`' || (ch === '$' && next === '(') || (platform === 'win32' && ch === '%'))
      ) {
        return {
          ok: false,
          reason: 'UNSAFE_SHELL_SYNTAX',
          rejectedSegment: command.slice(segmentStart).trim() || command.trim(),
        };
      } else if (ch === '\\' && quote === '"' && platform !== 'win32') {
        escape = true;
      }
      continue;
    }

    if (ch === '\\' && platform !== 'win32') {
      escape = true;
      continue;
    }

    if (ch === '"' || (ch === "'" && platform !== 'win32')) {
      quote = ch;
      continue;
    }

    if (
      ch === '`' ||
      (ch === '$' && next === '(') ||
      ch === '<' ||
      ch === '>' ||
      (platform === 'win32' && ch === '%')
    ) {
      return {
        ok: false,
        reason: 'UNSAFE_SHELL_SYNTAX',
        rejectedSegment: command.slice(segmentStart).trim() || command.trim(),
      };
    }

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
    dir.startsWith('\\') ||
    dir.startsWith('~') ||
    /^[A-Za-z]:/.test(dir) ||
    dir.startsWith('\\\\');
  return !isAbsoluteOrHome && !hasParentTraversal && dir.trim() !== '';
}

function startsWithReadonlyShellCommand(
  command: string,
  executable: string,
  platform: NodeJS.Platform,
): boolean {
  return matchesReadonlyShellPrefix(command, executable, platform);
}

function matchesReadonlyShellPrefix(
  command: string,
  prefix: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedCommand = platform === 'win32' ? command.toLowerCase() : command;
  const normalizedPrefix = platform === 'win32' ? prefix.toLowerCase() : prefix;
  return (
    normalizedCommand === normalizedPrefix ||
    new RegExp(`^${escapeRegexLiteral(normalizedPrefix)}\\s`, 'u').test(normalizedCommand)
  );
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCdChain(
  command: string,
  platform: NodeJS.Platform,
): Readonly<{ dir: string; rest: string }> | null {
  // Supports: cd <dir> && <rest>   or   cd <dir> || <rest>
  // `<dir>` may be quoted; Windows cmd.exe only treats double quotes as quotes.
  if (!/^cd\s+/iu.test(command)) return null;

  let i = 2;
  while (i < command.length && /\s/.test(command[i] ?? '')) i++;
  if (i >= command.length) return null;

  const start = i;
  const first = command[i] ?? '';
  if (first === '"' || (first === "'" && platform !== 'win32')) {
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

function splitShellTokens(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellToken[] {
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

    if (ch === '"' || (ch === "'" && platform !== 'win32')) {
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

function normalizeReadonlyShellToken(token: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? token.toLowerCase() : token;
}

function firstReadonlyShellToken(segment: string): string {
  const tokens = splitShellTokens(segment.trim());
  return normalizeReadonlyShellToken(tokens[0]?.text ?? '', process.platform);
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
  if (failure.reason === 'UNSAFE_SHELL_SYNTAX') {
    return 'Do not use redirects, command substitution, or Windows environment expansion in `readonly_shell`; run a plain allowlisted inspection command.';
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
  if (token === 'python3' || token === 'python' || token === 'py') {
    return 'Only version probes are allowed: `python3 --version || true` (or `python --version` / `py --version` on Windows).';
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
  if (failure.reason === 'UNSAFE_SHELL_SYNTAX') {
    return '请勿在 `readonly_shell` 中使用重定向或命令替换；请直接运行白名单检查命令。';
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
  if (token === 'python3' || token === 'python' || token === 'py') {
    return '仅允许版本探针：`python3 --version || true`（Windows 上也可用 `python --version` / `py --version`）。';
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

function detectForbiddenRtwsRootHiddenDir(
  relFromRoot: string,
  platform: NodeJS.Platform = process.platform,
): ForbiddenHiddenDir | null {
  const rawNormalized = normalizeRelFromRtwsRoot(relFromRoot);
  const normalized = platform === 'win32' ? rawNormalized.toLowerCase() : rawNormalized;
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
  platform: NodeJS.Platform = process.platform,
): ForbiddenHiddenDir | null {
  // Deny access to rtws-root `.minds/**` and `.dialogs/**` only.
  // Nested rtws (e.g. `ux-rtws/.minds/**`, `ux-rtws/.dialogs/**`) remains allowed.
  let baseDirRel = '.';
  let rest = command.trimStart();

  // Evaluate chained `cd ... && ...` prefixes and track base dir.
  while (startsWithReadonlyShellCommand(rest, 'cd', platform)) {
    const parsed = parseCdChain(rest, platform);
    if (!parsed) break;
    const dir = parsed.dir.replace(/^["']|["']$/g, '');
    const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, dir);
    const forbidden = detectForbiddenRtwsRootHiddenDir(relFromRoot, platform);
    if (forbidden) return forbidden;
    baseDirRel = path.join(baseDirRel, dir);
    rest = parsed.rest.trimStart();
  }

  const chainParsed = splitTopLevelReadonlyShellChain(rest, platform);
  if (chainParsed.ok && chainParsed.segments.length > 1) {
    for (const segment of chainParsed.segments) {
      const forbidden = detectReadonlyShellForbiddenHiddenDirAccessInSegment(
        workspaceRootAbs,
        baseDirRel,
        segment,
        platform,
      );
      if (forbidden) return forbidden;
    }
    return null;
  }

  return detectReadonlyShellForbiddenHiddenDirAccessInSegment(
    workspaceRootAbs,
    baseDirRel,
    rest,
    platform,
  );
}

export function detectReadonlyShellForbiddenHiddenDirAccessForTests(
  workspaceRootAbs: string,
  command: string,
  platform: NodeJS.Platform,
): ForbiddenHiddenDir | null {
  return detectReadonlyShellForbiddenHiddenDirAccess(workspaceRootAbs, command, platform);
}

function detectReadonlyShellForbiddenHiddenDirAccessInSegment(
  workspaceRootAbs: string,
  baseDirRel: string,
  segment: string,
  platform: NodeJS.Platform,
): ForbiddenHiddenDir | null {
  const tokens = splitShellTokens(segment, platform);
  const cmdRaw = tokens[0]?.text ?? '';
  const cmd = platform === 'win32' ? cmdRaw.toLowerCase() : cmdRaw;
  if (!cmd) return null;

  const tokenText = (i: number): string | null => {
    const v = tokens[i];
    if (!v) return null;
    return v.text;
  };

  const checkPathToken = (raw: string): ForbiddenHiddenDir | null => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '--') return null;
    const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, trimmed);
    return detectForbiddenRtwsRootHiddenDir(relFromRoot, platform);
  };

  const checkGitPathspecToken = (raw: string, gitBaseDirRel: string): ForbiddenHiddenDir | null => {
    let pathspec = raw.trim();
    if (pathspec === '' || pathspec === '-' || pathspec === '--') return null;
    if (pathspec.startsWith(':(')) {
      const magicEnd = pathspec.indexOf(')');
      if (magicEnd >= 0) pathspec = pathspec.slice(magicEnd + 1);
    }
    if (pathspec.startsWith(':/')) pathspec = pathspec.slice(2);
    if (pathspec.startsWith(':')) pathspec = pathspec.slice(1);
    const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, gitBaseDirRel, pathspec);
    return detectForbiddenRtwsRootHiddenDir(relFromRoot, platform);
  };

  if (cmd === 'git') {
    let gitBaseDirRel = baseDirRel;
    let argsStart = 2;
    if (tokenText(1) === '-C') {
      const dirToken = tokenText(2);
      if (dirToken) {
        const relFromRoot = resolveRelFromRtwsRoot(workspaceRootAbs, baseDirRel, dirToken);
        const forbidden = detectForbiddenRtwsRootHiddenDir(relFromRoot, platform);
        if (forbidden) return forbidden;
        gitBaseDirRel = path.join(baseDirRel, dirToken);
      }
      argsStart = 4;
    }
    for (let index = argsStart; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token || token === '--' || token.startsWith('-')) continue;
      const forbidden = checkGitPathspecToken(token, gitBaseDirRel);
      if (forbidden) return forbidden;
    }
    return null;
  }

  // Command-specific parsing to avoid false-positives where `.minds` is just a pattern/filter.
  if (cmd === 'rg') {
    // `rg [OPTIONS] PATTERN [PATH ...]`; `rg --files [PATH ...]` has no pattern.
    let index = 1;
    let filesMode = false;
    let patternConsumed = false;
    while (index < tokens.length) {
      const token = tokenText(index);
      if (!token) break;
      if (token === '--') {
        index += 1;
        break;
      }
      if (token === '--files') {
        filesMode = true;
        index += 1;
        continue;
      }
      if (token === '-g' || token === '--glob' || token === '--iglob' || token === '-f') {
        const optionValue = tokenText(index + 1);
        if (optionValue) {
          const forbidden = checkPathToken(optionValue);
          if (forbidden) return forbidden;
        }
        index += 2;
        continue;
      }
      if ((token.startsWith('-g') || token.startsWith('-f')) && token.length > 2) {
        const optionValue = token.slice(2);
        const forbidden = checkPathToken(optionValue);
        if (forbidden) return forbidden;
        index += 1;
        continue;
      }
      if (
        token.startsWith('--glob=') ||
        token.startsWith('--iglob=') ||
        token.startsWith('--file=')
      ) {
        const optionValue = token.slice(token.indexOf('=') + 1);
        const forbidden = checkPathToken(optionValue);
        if (forbidden) return forbidden;
        index += 1;
        continue;
      }
      if (token === '-e' || token === '--regexp') {
        index += 2;
        continue;
      }
      if (token.startsWith('--regexp=')) {
        index += 1;
        continue;
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      if (!filesMode && !patternConsumed) {
        patternConsumed = true;
        index += 1;
        continue;
      }
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
      index += 1;
    }
    for (; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token) continue;
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
    }
    return null;
  }

  if (cmd === 'jq') {
    // `jq [OPTIONS] FILTER [FILE ...]`; some options read files before FILTER.
    let index = 1;
    while (index < tokens.length) {
      const token = tokenText(index);
      if (!token) break;
      if (token === '--') {
        index += 1;
        break;
      }
      if (token === '-f' || token === '--from-file') {
        const optionValue = tokenText(index + 1);
        if (optionValue) {
          const forbidden = checkPathToken(optionValue);
          if (forbidden) return forbidden;
        }
        index += 2;
        continue;
      }
      if (token.startsWith('--from-file=')) {
        const optionValue = token.slice(token.indexOf('=') + 1);
        const forbidden = checkPathToken(optionValue);
        if (forbidden) return forbidden;
        index += 1;
        continue;
      }
      if (token === '--slurpfile' || token === '--rawfile' || token === '--argfile') {
        const fileValue = tokenText(index + 2);
        if (fileValue) {
          const forbidden = checkPathToken(fileValue);
          if (forbidden) return forbidden;
        }
        index += 3;
        continue;
      }
      if (token === '--arg' || token === '--argjson') {
        index += 3;
        continue;
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      // First non-flag token is FILTER (do not treat as a file path).
      index += 1;
      break;
    }
    for (; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token) continue;
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
    }
    return null;
  }

  if (cmd === 'where') {
    // Windows `where /r <dir> <pattern>` recursively searches a directory.
    for (let index = 1; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token) continue;
      if (token.toLowerCase() === '/r' || token.toLowerCase() === '-r') {
        const optionValue = tokenText(index + 1);
        if (optionValue) {
          const forbidden = checkPathToken(optionValue);
          if (forbidden) return forbidden;
        }
        index += 1;
      }
    }
    return null;
  }

  if (cmd === 'findstr') {
    // `findstr [OPTIONS] STRINGS [FILE ...]` — treat the first non-option as the pattern.
    let index = 1;
    while (index < tokens.length) {
      const token = tokenText(index);
      if (!token) break;
      const findstrOptionPath = /^[/\-](?:f|g|d):(.+)$/iu.exec(token);
      if (findstrOptionPath) {
        const optionValue = findstrOptionPath[1] ?? '';
        const optionPaths = /^[/\-]d:/iu.test(token) ? optionValue.split(';') : [optionValue];
        for (const optionPath of optionPaths) {
          const forbidden = checkPathToken(optionPath);
          if (forbidden) return forbidden;
        }
        index += 1;
        continue;
      }
      if (token.startsWith('/') || token.startsWith('-')) {
        index += 1;
        continue;
      }
      index += 1;
      break;
    }
    for (; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token) continue;
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
    }
    return null;
  }

  if (cmd === 'awk') {
    let index = 1;
    let programConsumed = false;
    while (index < tokens.length) {
      const token = tokenText(index);
      if (!token) break;
      if (token === '-f' || token === '--file') {
        const optionValue = tokenText(index + 1);
        if (optionValue) {
          const forbidden = checkPathToken(optionValue);
          if (forbidden) return forbidden;
        }
        programConsumed = true;
        index += 2;
        continue;
      }
      if (token.startsWith('-f') && token.length > 2) {
        const optionValue = token.slice(2);
        const forbidden = checkPathToken(optionValue);
        if (forbidden) return forbidden;
        programConsumed = true;
        index += 1;
        continue;
      }
      if (token.startsWith('--file=')) {
        const optionValue = token.slice(token.indexOf('=') + 1);
        const forbidden = checkPathToken(optionValue);
        if (forbidden) return forbidden;
        programConsumed = true;
        index += 1;
        continue;
      }
      if (token === '-v' || token === '-F') {
        index += 2;
        continue;
      }
      if (token.startsWith('-F') && token.length > 2) {
        index += 1;
        continue;
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      if (!programConsumed) {
        programConsumed = true;
        index += 1;
        continue;
      }
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
      index += 1;
    }
    return null;
  }

  if (cmd === 'find') {
    // `find [global-options] [path ...] [expression]` — treat only initial roots as paths.
    for (let index = 1; index < tokens.length; index++) {
      const token = tokenText(index);
      if (!token) continue;
      if (token === '-H' || token === '-L' || token === '-P' || /^-O[0-9]$/.test(token)) {
        continue;
      }
      if (token === '-D') {
        index += 1;
        continue;
      }
      if (token.startsWith('-')) break;
      if (token === '!' || token === '(' || token === ')') break;
      const forbidden = checkPathToken(token);
      if (forbidden) return forbidden;
    }
    return null;
  }

  // Default conservative: treat non-flag args as potential paths for common file-inspection commands.
  // This intentionally does NOT block `echo/printf/...` where args are data, not paths.
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
    'cut',
    'sort',
    'uniq',
    'shasum',
    'sha256sum',
    'md5sum',
    'tree',
    'sed',
    'dir',
    'type',
    'more',
    'fc',
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
    'Execute a read-only shell command from a small allowlist. On Windows this runs through cmd.exe, so use allowlisted cmd/PATH commands such as `rg`, `git`, `dir`, `type`, or `where`. Only exact version probes are allowed for node/python (no scripts such as `node -e` or `python3 -c`). Command chains via |/&&/|| are validated segment-by-segment. Commands outside the allowlist are rejected.',
  descriptionI18n: {
    en: 'Execute a read-only shell command from a small allowlist. On Windows this runs through cmd.exe, so use allowlisted cmd/PATH commands such as `rg`, `git`, `dir`, `type`, or `where`. Only exact version probes are allowed for node/python (no scripts such as `node -e` or `python3 -c`). Command chains via |/&&/|| are validated segment-by-segment. You are explicitly authorized to call this tool yourself (no delegation). Commands outside the allowlist are rejected.',
    zh: '执行只读 shell 命令，仅允许少量白名单命令前缀。Windows 上通过 cmd.exe 执行，请使用白名单内且 cmd/PATH 可用的命令，例如 `rg`、`git`、`dir`、`type` 或 `where`。对 node/python 仅允许版本探针（不允许 `node -e` / `python3 -c` 这类脚本）。通过 |/&&/|| 串联时会按子命令逐段校验。你已被明确授权自行调用该工具（无需委派）。不在允许列表内的命令会被拒绝。',
  },
  parameters: readonlyShellSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseReadonlyShellArgs(args);
    const { command, timeoutMs = 10_000 } = parsedArgs;
    const warning = detectWindowsShellUsageWarning(command, undefined, language);

    if (command.includes('\n') || command.includes('\r')) {
      return toolFailure(
        prependShellWarning(
          language === 'zh'
            ? `❌ readonly_shell 不建议执行多行脚本式命令（检测到换行符）。请用单行命令（允许 |、&&、||）。\n收到：${command}`
            : `❌ readonly_shell does not allow multi-line script-style commands (newline detected). Use a single-line command (|, &&, || are allowed).\nGot: ${command}`,
          warning,
        ),
      );
    }

    const validation = validateReadonlyShellCommand(command);
    if (!validation.ok) {
      const allowedList = getReadonlyShellAllowedPrefixes().join(', ');
      const rejectedSegment = validation.failure.rejectedSegment.trim();
      const rejectedSegmentOrCommand = rejectedSegment === '' ? command : rejectedSegment;
      const suggestion =
        language === 'zh'
          ? getReadonlyShellSuggestionZh(validation.failure)
          : getReadonlyShellSuggestionEn(validation.failure);
      return toolFailure(
        prependShellWarning(
          language === 'zh'
            ? `❌ readonly_shell 仅允许以下命令前缀：${allowedList}\n另外允许（仅版本探针）：node --version|-v、python3/python/py --version|-V\n脚本执行（如 node -e / python3 -c）一律拒绝。\n另外允许：git -C <相对路径> <show|status|diff|log|blame> ...\n另外允许：cd <相对路径> && <允许命令...>（或 ||）\nWindows 上通过 cmd.exe 执行；请使用该 shell/PATH 中可用的白名单命令。\n说明：通过 |/&&/|| 串联时会按子命令逐段校验。\n被拒子命令段：${rejectedSegmentOrCommand}\n允许的等价写法：${suggestion}\n收到：${command}`
            : `❌ readonly_shell only allows these command prefixes: ${allowedList}\nAlso allowed (exact version probes only): node --version|-v, python3/python/py --version|-V\nNode/python scripts (for example: node -e, python3 -c) are rejected.\nAlso allowed: git -C <relative-path> <show|status|diff|log|blame> ...\nAlso allowed: cd <relative-path> && <allowed command...> (or ||)\nOn Windows this runs through cmd.exe; use allowlisted commands available in that shell/PATH.\nNote: chains via |/&&/|| are validated segment-by-segment.\nRejected segment: ${rejectedSegmentOrCommand}\nAllowed equivalent: ${suggestion}\nGot: ${command}`,
          warning,
        ),
      );
    }

    const forbiddenHiddenDir = detectReadonlyShellForbiddenHiddenDirAccess(
      domindsRtwsRootAbs(),
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
        env: buildCapturedShellEnv(),
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
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

        let result = prependShellWarning(`${timeoutMsg}${truncationNotice}`.trimEnd(), warning);

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
        let result = prependShellWarning(t.commandCompleted(code, truncationNotice), warning);

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
        finish(toolFailure(prependShellWarning(t.failedToExecute(error.message), warning)));
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
    const reminders = await loadSharedReminders({ kind: 'agent', agentId: dlg.agentId });
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
            { type: 'stop', entirePg },
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

    const reminders = await loadSharedReminders({ kind: 'agent', agentId: dlg.agentId });
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
