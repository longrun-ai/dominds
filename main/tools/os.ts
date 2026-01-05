/**
 * Module: tools/os
 *
 * Operating system interaction tools for shell command execution.
 * Provides shell_cmd and stop_daemon FuncTools with advanced process management.
 */

import { ChildProcess, spawn } from 'child_process';
import type { Dialog } from '../dialog';
import type { ChatMessage } from '../llm/client';
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShellCmdReminderMeta(meta: JsonValue | undefined): meta is ShellCmdReminderMeta {
  return isJsonObject(meta) && typeof meta.pid === 'number';
}

function parseShellCmdArgs(args: ToolArguments): ShellCmdArgs {
  const command = args.command;
  if (typeof command !== 'string') {
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
    shell,
    bufferSize,
    timeoutSeconds,
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
  if (stream !== undefined && stream !== 'stdout' && stream !== 'stderr') {
    throw new Error('get_daemon_output.stream must be "stdout" or "stderr" if provided');
  }

  return { pid, stream };
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
        content: `🔔 **System Reminder #${index + 1}** - Process Management Context
I need to evaluate this reminder's current relevance to system operations and issue \`@delete_reminder ${index + 1}\` if the context has changed or the task is complete.
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
This daemon process has completed its lifecycle and is no longer running. I should clean up this tracking reminder with \`@delete_reminder ${index + 1}\` to maintain system hygiene.`,
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
This daemon process is actively running and requires periodic assessment. I should check its health, resource usage, and operational status. Use \`@delete_reminder ${index + 1}\` when monitoring is no longer needed or if the process should be terminated.

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
  parameters: shellCmdSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
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

        resolve(
          `🔄 Command started as daemon process (PID: ${pid})\nThe process didn't complete within ${timeoutSeconds} seconds and is now running in the background.\nA reminder has been added to track its progress.\n\nUse stop_daemon({"pid": ${pid}}) to terminate it when needed.`,
        );
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
          scrollNotice = `\n⚠️  ${scrolledLines} lines scrolled out of view during execution`;
        }

        const stdoutContent = stdoutBuffer.getContent();
        const stderrContent = stderrBuffer.getContent();

        const fenceConsole = '```console';
        const fenceEnd = '```';
        let result = `✅ Command completed (exit code: ${code})${scrollNotice}\n\n`;

        if (stdoutContent) {
          result += `📤 stdout:\n${fenceConsole}\n${stdoutContent}\n${fenceEnd}\n\n`;
        }

        if (stderrContent) {
          result += `📤 stderr:\n${fenceConsole}\n${stderrContent}\n${fenceEnd}`;
        }

        resolve(result.trim());
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        resolve(`❌ Failed to execute command: ${error.message}`);
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
  parameters: stopDaemonSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const { pid } = parseStopDaemonArgs(args);

    const daemon = daemonProcesses.get(pid);
    if (!daemon) {
      return `❌ No daemon process found with PID ${pid}`;
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

      return `✅ Daemon process ${pid} (${daemon.command}) stopped successfully`;
    } catch (error) {
      daemonProcesses.delete(pid); // Clean up tracking even if kill failed
      return `❌ Failed to stop daemon process ${pid}: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

// Get daemon output tool implementation
export const getDaemonOutputTool: FuncTool = {
  type: 'func',
  name: 'get_daemon_output',
  description:
    'Retrieve captured stdout/stderr output from a tracked daemon process by PID. Call this to check what a daemon has logged since it started. Returns (no output) if nothing has been written yet.',
  parameters: getDaemonOutputSchema,
  async call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> {
    const { pid, stream = 'stdout' } = parseGetDaemonOutputArgs(args);

    const daemon = daemonProcesses.get(pid);
    if (!daemon) {
      return `❌ No daemon process found with PID ${pid}`;
    }

    const buffer = stream === 'stdout' ? daemon.stdoutBuffer : daemon.stderrBuffer;
    const scrollInfo = buffer.getScrollInfo();
    const content = buffer.getContent();

    const streamLabel = stream === 'stdout' ? 'stdout' : 'stderr';
    const fenceConsole = '```console';
    const fenceEnd = '```';

    let result = `📤 Daemon ${pid} ${streamLabel} output:\n`;

    if (content) {
      result += `${fenceConsole}\n${content}\n${fenceEnd}`;
    } else {
      result += '(no output)';
    }

    if (scrollInfo.hasScrolledContent) {
      result += `\n\n⚠️  ${scrollInfo.linesScrolledOut} lines have scrolled out of view`;
    }

    return result;
  },
};
