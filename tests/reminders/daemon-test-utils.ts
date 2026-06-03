import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function quoteShellArg(arg: string): string {
  if (process.platform === 'win32') {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function withTempCwd<T>(
  prefix: string,
  fn: (sandboxDir: string) => Promise<T>,
): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await removeTempDirWithRetry(sandboxDir);
  }
}

async function removeTempDirWithRetry(sandboxDir: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 4 : 120;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.rm(sandboxDir, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      if (attempt === maxAttempts - 1) {
        if (process.platform === 'win32') {
          scheduleWindowsDeferredTempCleanup(sandboxDir);
          console.warn(`Deferred cleanup of locked temp directory: ${sandboxDir}`);
          return;
        }
        throw error;
      }
      await delay(250);
    }
  }
}

function scheduleWindowsDeferredTempCleanup(sandboxDir: string): void {
  const cleanupScript = `
const fs = require('node:fs/promises');
const dir = process.argv[1];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      process.exit(0);
    } catch {
      await delay(250);
    }
  }
  process.exit(1);
})();
`;
  const child = spawn(process.execPath, ['-e', cleanupScript, sandboxDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export async function writeDaemonScriptCommand(
  dirPath: string,
  fileName: string,
  source: string,
  windowsPowerShellSource: string,
): Promise<string> {
  if (process.platform === 'win32') {
    return windowsPowerShellSource.trim();
  }
  const scriptPath = path.join(dirPath, fileName);
  await fs.writeFile(scriptPath, `${source.trim()}\n`, 'utf-8');
  return `node ${quoteShellArg(fileName)}`;
}

export function daemonScriptShell(): string | undefined {
  return process.platform === 'win32' ? 'powershell.exe' : undefined;
}
