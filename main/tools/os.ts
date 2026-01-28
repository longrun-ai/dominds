/**
 * Module: tools/os
 *
 * Operating system interaction tools for shell command execution.
 * Provides shell_cmd and stop_daemon FuncTools with advanced process management.
 */

import { ChildProcess, spawn } from 'child_process';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
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
} from '../tool';

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
  shell: string;
  process: ChildProcess;
  startTime: Date;
  stdoutBuffer: ScrollingBuffer;
  stderrBuffer: ScrollingBuffer;
  isRunning: boolean;
  exitCode?: number;
  exitSignal?: string;
  lastUpdateTime: Date;
}

// Global registry for daemon processes
const daemonProcesses = new Map<number, DaemonProcess>();

// Shell command arguments interface
interface ShellCmdArgs {
  command: string;
  shell?: string;
  bufferSize?: number;
  timeoutSeconds?: number;
}

interface ReadonlyShellArgs {
  command: string;
  timeoutMs?: number;
}

// Stop daemon arguments interface
interface StopDaemonArgs {
  pid: number;
}

// Get daemon output arguments interface
interface GetDaemonOutputArgs {
  pid: number;
  stream?: 'stdout' | 'stderr';
}

type ShellCmdReminderMeta = JsonObject & {
  pid: number;
  completed?: boolean;
  lastUpdated?: string;
};

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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShellCmdReminderMeta(meta: JsonValue | undefined): meta is ShellCmdReminderMeta {
  return isJsonObject(meta) && typeof meta.pid === 'number';
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

  const bufferSize = args.bufferSize;
  if (bufferSize !== undefined && typeof bufferSize !== 'number') {
    throw new Error('shell_cmd.bufferSize must be a number if provided');
  }

  const timeoutSeconds = args.timeoutSeconds;
  if (timeoutSeconds !== undefined && typeof timeoutSeconds !== 'number') {
    throw new Error('shell_cmd.timeoutSeconds must be a number if provided');
  }

  return {
    command,
    shell: typeof shell === 'string' && shell.trim() !== '' ? shell : undefined,
    bufferSize:
      bufferSize === 0
        ? undefined
        : bufferSize === undefined
          ? undefined
          : Number.isInteger(bufferSize) && bufferSize > 0
            ? bufferSize
            : (() => {
                throw new Error(
                  'shell_cmd.bufferSize must be a positive integer (or 0 for default)',
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
  return { pid };
}

function parseGetDaemonOutputArgs(args: ToolArguments): GetDaemonOutputArgs {
  const pid = args.pid;
  if (typeof pid !== 'number') {
    throw new Error('get_daemon_output.pid must be a number');
  }

  const stream = args.stream;
  if (stream !== undefined && stream !== '' && stream !== 'stdout' && stream !== 'stderr') {
    throw new Error('get_daemon_output.stream must be "stdout" or "stderr" if provided');
  }

  return { pid, stream: stream === '' ? undefined : stream };
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
      description: 'Shell to use for execution (default: bash)',
    },
    bufferSize: {
      type: 'number',
      description: 'Maximum number of lines to keep in scrolling buffer (default: 500)',
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
      description: 'Read-only shell command (allowed prefixes: cat, rg, sed, ls, nl, wc, git show)',
    },
    timeout_ms: {
      type: 'number',
      description: 'Maximum time in milliseconds the command is allowed to run (default: 10000)',
    },
    timeout: {
      type: 'number',
      description: 'Alias for timeout_ms',
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
    stream: {
      type: 'string',
      description: 'Output stream to retrieve - "stdout" or "stderr" (default: stdout)',
    },
  },
  required: ['pid'],
  additionalProperties: false,
};

// Format daemon status for reminder display
function formatDaemonStatus(daemon: DaemonProcess): string {
  const uptime = Math.floor((Date.now() - daemon.startTime.getTime()) / 1000);
  const status = daemon.isRunning
    ? 'running'
    : `exited (code: ${daemon.exitCode}, signal: ${daemon.exitSignal})`;

  const stdoutInfo = daemon.stdoutBuffer.getScrollInfo();
  const stderrInfo = daemon.stderrBuffer.getScrollInfo();

  let scrollNotice = '';
  if (stdoutInfo.hasScrolledContent || stderrInfo.hasScrolledContent) {
    const scrolledLines = stdoutInfo.linesScrolledOut + stderrInfo.linesScrolledOut;
    scrollNotice = `\n⚠️  ${scrolledLines} lines have scrolled out of view`;
  }

  const stdoutContent = daemon.stdoutBuffer.isEmpty()
    ? '(no output)'
    : daemon.stdoutBuffer.getContent();
  const stderrContent = daemon.stderrBuffer.isEmpty()
    ? '(no errors)'
    : daemon.stderrBuffer.getContent();
  const fenceConsole = '```console';
  const fenceEnd = '```';

  return `🔄 Daemon Process ${daemon.pid}
Command: ${daemon.command}
Shell: ${daemon.shell}
Status: ${status}
Uptime: ${uptime}s
Started: ${formatUnifiedTimestamp(daemon.startTime)}${scrollNotice}

📤 Latest stdout:
${fenceConsole}
${stdoutContent}
${fenceEnd}

📤 Latest stderr:
${fenceConsole}
${stderrContent}
${fenceEnd}

💡 Use stop_daemon({"pid": ${daemon.pid}}) to terminate this process`;
}

// ReminderOwner implementation for shell command tool
export const shellCmdReminderOwner: ReminderOwner = {
  name: 'shellCmd',
  async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
    if (reminder.owner !== shellCmdReminderOwner || !isShellCmdReminderMeta(reminder.meta)) {
      return { treatment: 'keep' };
    }

    const pid = reminder.meta.pid;
    const daemon = daemonProcesses.get(pid);

    if (!daemon) {
      // Daemon process no longer exists
      return { treatment: 'drop' };
    }

    // Check if process has exited
    if (!daemon.isRunning) {
      // Process has exited, provide final status and drop reminder
      const finalStatus = formatDaemonStatus(daemon);
      daemonProcesses.delete(pid);

      return {
        treatment: 'update',
        updatedContent: `🏁 Process ${pid} has completed:\n\n${finalStatus}`,
        updatedMeta: {
          ...reminder.meta,
          completed: true,
          lastUpdated: formatUnifiedTimestamp(new Date()),
        },
      };
    }

    // Update daemon status
    daemon.lastUpdateTime = new Date();

    // Check if process is still actually running
    try {
      process.kill(pid, 0); // Signal 0 checks if process exists
    } catch (error) {
      // Process no longer exists
      daemon.isRunning = false;
      daemon.exitCode = -1;
      daemon.exitSignal = 'UNKNOWN';
    }

    // Update the reminder with current daemon status
    const updatedContent = formatDaemonStatus(daemon);
    return {
      treatment: 'update',
      updatedContent,
      updatedMeta: {
        ...reminder.meta,
        lastUpdated: formatUnifiedTimestamp(daemon.lastUpdateTime),
      },
    };
  },

  async renderReminder(dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage> {
    if (reminder.owner !== shellCmdReminderOwner || !isShellCmdReminderMeta(reminder.meta)) {
      // Fallback to default rendering if this reminder doesn't belong to this tool
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: `🔔 **System-managed reminder item #${index + 1}** - Process Management
This reminder is system-managed and should update/drop automatically based on the underlying process lifecycle.
---
${reminder.content}`,
      };
    }

    const pid = reminder.meta.pid;
    const daemon = daemonProcesses.get(pid);

    if (!daemon) {
      // Daemon no longer exists, render as completed
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: `⚰️ **Process Lifecycle Alert #${index + 1}** - Daemon Terminated (PID ${pid})
This daemon process has completed its lifecycle and is no longer running. This reminder should auto-drop (or can be ignored).`,
      };
    }

    // Render with current daemon status - fully dynamic
    const uptime = Math.floor((Date.now() - daemon.startTime.getTime()) / 1000);
    const uptimeStr =
      uptime < 60
        ? `${uptime}s`
        : uptime < 3600
          ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
          : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    const statusInfo = formatDaemonStatus(daemon);

    return {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: `🔄 **Active Daemon Monitor #${index + 1}** - PID ${pid} (Uptime: ${uptimeStr})
This daemon process is actively running and requires periodic assessment. I should check its health, resource usage, and operational status. This reminder is system-managed and will update/drop automatically.

**Current Status:**
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
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseShellCmdArgs(args);
    const { command, shell = 'bash', bufferSize = 500, timeoutSeconds = 5 } = parsedArgs;

    const stdoutBuffer = new ScrollingBuffer(bufferSize);
    const stderrBuffer = new ScrollingBuffer(bufferSize);

    return new Promise((resolve) => {
      const childProcess = spawn(shell, ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const pid = childProcess.pid!;
      const startTime = new Date();

      // Set up data handlers
      childProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer.addText(data.toString());
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderrBuffer.addText(data.toString());
      });

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        // Process didn't exit within timeout - treat as daemon
        const daemon: DaemonProcess = {
          pid,
          command,
          shell,
          process: childProcess,
          startTime,
          stdoutBuffer,
          stderrBuffer,
          isRunning: true,
          lastUpdateTime: new Date(),
        };

        daemonProcesses.set(pid, daemon);

        // Add reminder for daemon process
        const reminderContent = `[Daemon PID ${pid} - This content should not be visible, check dynamic rendering]`;
        dlg.addReminder(reminderContent, shellCmdReminderOwner, {
          type: 'daemon',
          pid,
          command,
          shell,
          startTime: formatUnifiedTimestamp(startTime),
        });

        resolve(t.daemonStarted(pid, timeoutSeconds, command));
      }, timeoutSeconds * 1000);

      // Handle process completion
      childProcess.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);

        // Process completed within timeout - return full output
        const stdoutInfo = stdoutBuffer.getScrollInfo();
        const stderrInfo = stderrBuffer.getScrollInfo();

        let scrollNotice = '';
        if (stdoutInfo.hasScrolledContent || stderrInfo.hasScrolledContent) {
          const scrolledLines = stdoutInfo.linesScrolledOut + stderrInfo.linesScrolledOut;
          scrollNotice = t.scrolledLinesNotice(scrolledLines);
        }

        const stdoutContent = stdoutBuffer.getContent();
        const stderrContent = stderrBuffer.getContent();

        const fenceConsole = '```console';
        const fenceEnd = '```';
        let result = t.commandCompleted(code, scrollNotice);

        if (stdoutContent) {
          result += `${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}\n\n`;
        }

        if (stderrContent) {
          result += `${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        resolve(result.trim());
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        resolve(t.failedToExecute(error.message));
      });
    });
  },
};

const readonlyShellAllowedPrefixes = ['cat', 'rg', 'sed', 'ls', 'nl', 'wc', 'git show'] as const;

function isAllowedReadonlyShellCommand(command: string): boolean {
  const trimmed = command.trimStart();
  for (const prefix of readonlyShellAllowedPrefixes) {
    if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
      return true;
    }
  }
  return false;
}

export const readonlyShellTool: FuncTool = {
  type: 'func',
  name: 'readonly_shell',
  description:
    'Execute a read-only shell command from a small allowlist (cat, rg, sed, ls, nl, wc, git show). Commands outside the allowlist are rejected.',
  descriptionI18n: {
    en: 'Execute a read-only shell command from a small allowlist (cat, rg, sed, ls, nl, wc, git show). You are explicitly authorized to call this tool yourself (no delegation). Commands outside the allowlist are rejected.',
    zh: '执行只读 shell 命令（仅允许：cat、rg、sed、ls、nl、wc、git show）。你已被明确授权自行调用该工具（无需委派）。不在允许列表内的命令会被拒绝。',
  },
  parameters: readonlyShellSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const parsedArgs = parseReadonlyShellArgs(args);
    const { command, timeoutMs = 10_000 } = parsedArgs;

    if (!isAllowedReadonlyShellCommand(command)) {
      const allowedList = readonlyShellAllowedPrefixes.join(', ');
      return language === 'zh'
        ? `❌ readonly_shell 仅允许以下命令前缀：${allowedList}\n收到：${command}`
        : `❌ readonly_shell only allows these command prefixes: ${allowedList}\nGot: ${command}`;
    }

    const stdoutBuffer = new HeadTailByteBuffer(1024 * 1024);
    const stderrBuffer = new HeadTailByteBuffer(1024 * 1024);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (content: string): void => {
        if (settled) return;
        settled = true;
        resolve(content.trim());
      };

      const childProcess = spawn('bash', ['-c', command], {
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

        const stdoutContent = stdoutBuffer.getContent();
        const stderrContent = stderrBuffer.getContent();

        if (stdoutContent) {
          result += `\n\n${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}`;
        }

        if (stderrContent) {
          result += `\n\n${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        finish(result);
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

        const stdoutContent = stdoutBuffer.getContent();
        const stderrContent = stderrBuffer.getContent();

        const fenceConsole = '```console';
        const fenceEnd = '```';
        let result = t.commandCompleted(code, truncationNotice);

        if (stdoutContent) {
          result += `${t.stdoutLabel}\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}\n\n`;
        }

        if (stderrContent) {
          result += `${t.stderrLabel}\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        finish(result);
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        finish(t.failedToExecute(error.message));
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
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const { pid } = parseStopDaemonArgs(args);

    const daemon = daemonProcesses.get(pid);
    if (!daemon) {
      return t.noDaemonFound(pid);
    }

    try {
      // Kill the process
      process.kill(pid, 'SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Force kill if still running
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        // Process already terminated
      }

      // Update daemon status
      daemon.isRunning = false;
      daemon.exitCode = -1;
      daemon.exitSignal = 'SIGTERM';

      // Remove associated reminders
      const indicesToRemove: number[] = [];
      for (let i = 0; i < dlg.reminders.length; i++) {
        const reminder = dlg.reminders[i];
        if (
          reminder.owner === shellCmdReminderOwner &&
          isShellCmdReminderMeta(reminder.meta) &&
          reminder.meta.pid === pid
        ) {
          indicesToRemove.push(i);
        }
      }

      // Remove reminders in reverse order to maintain indices
      for (let i = indicesToRemove.length - 1; i >= 0; i--) {
        dlg.deleteReminder(indicesToRemove[i]);
      }

      // Clean up daemon tracking
      daemonProcesses.delete(pid);

      return t.daemonStopped(pid, daemon.command);
    } catch (error) {
      daemonProcesses.delete(pid); // Clean up tracking even if kill failed
      return t.failedToStop(pid, error instanceof Error ? error.message : String(error));
    }
  },
};

// Get daemon output tool implementation
export const getDaemonOutputTool: FuncTool = {
  type: 'func',
  name: 'get_daemon_output',
  description:
    'Retrieve captured stdout/stderr output from a tracked daemon process by PID. Call this to check what a daemon has logged since it started. Returns (no output) if nothing has been written yet.',
  descriptionI18n: {
    en: 'Retrieve captured stdout/stderr output from a tracked daemon process by PID. Call this to check what a daemon has logged since it started. Returns (no output) if nothing has been written yet.',
    zh: '根据 PID 获取已追踪守护进程的 stdout/stderr 输出。用于查看守护进程自启动以来产生的日志；如果尚无输出则返回 (no output)。',
  },
  parameters: getDaemonOutputSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const language = getWorkLanguage();
    const t = getOsToolMessages(language);
    const { pid, stream = 'stdout' } = parseGetDaemonOutputArgs(args);

    const daemon = daemonProcesses.get(pid);
    if (!daemon) {
      return t.noDaemonFound(pid);
    }

    const buffer = stream === 'stdout' ? daemon.stdoutBuffer : daemon.stderrBuffer;
    const scrollInfo = buffer.getScrollInfo();
    const content = buffer.getContent();

    const streamLabel = stream === 'stdout' ? 'stdout' : 'stderr';
    const fenceConsole = '```console';
    const fenceEnd = '```';

    let result = t.daemonOutputHeader(pid, streamLabel);

    if (content) {
      result += `${fenceConsole}\n${content}\n${fenceEnd}`;
    } else {
      result += t.noOutput;
    }

    if (scrollInfo.hasScrolledContent) {
      result += t.scrolledOutNotice(scrollInfo.linesScrolledOut);
    }

    return result;
  },
};
