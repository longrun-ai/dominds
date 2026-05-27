import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function sleepMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildWindowsTaskkillArgs(pid: number, force: boolean): string[] {
  assertValidPid(pid);
  return force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
}

function assertValidPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process pid: ${String(pid)}`);
  }
}

async function bestEffortTaskkill(pid: number, force: boolean): Promise<void> {
  try {
    await execFileAsync('taskkill.exe', buildWindowsTaskkillArgs(pid, force), {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Best effort only.
  }
}

export async function bestEffortKillWindowsProcessTree(pid: number): Promise<void> {
  assertValidPid(pid);
  await bestEffortTaskkill(pid, false);
  await sleepMs(1_000);
  await bestEffortTaskkill(pid, true);
  bestEffortKillPid(pid);
}

export function bestEffortKillPid(pid: number): void {
  assertValidPid(pid);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Best effort only.
  }
}
