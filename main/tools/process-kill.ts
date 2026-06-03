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

async function bestEffortListWindowsDescendantPids(pid: number): Promise<number[]> {
  assertValidPid(pid);
  try {
    const command = `
$processes = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$frontier = @(${String(pid)})
$result = @()
while ($frontier.Count -gt 0) {
  $next = @()
  foreach ($parentPid in $frontier) {
    foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $parentPid }) {
      $childPid = [int]$child.ProcessId
      $result += $childPid
      $next += $childPid
    }
  }
  $frontier = $next
}
$result | ForEach-Object { [Console]::Out.WriteLine($_) }
`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const parsedPid = Number(trimmed);
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        parsed.push(parsedPid);
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function bestEffortKillWindowsProcessTree(pid: number): Promise<void> {
  assertValidPid(pid);
  const descendantPids = await bestEffortListWindowsDescendantPids(pid);
  for (const descendantPid of descendantPids.slice().reverse()) {
    await bestEffortTaskkill(descendantPid, false);
  }
  await bestEffortTaskkill(pid, false);
  await sleepMs(1_000);
  for (const descendantPid of descendantPids.slice().reverse()) {
    await bestEffortTaskkill(descendantPid, true);
    bestEffortKillPid(descendantPid);
  }
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
