import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { materializeReminder } from '../../main/tool';
import { resetTrackedDaemonsForTests, shellCmdReminderOwner } from '../../main/tools/os';

const execFileAsync = promisify(execFile);

async function withTempDir<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-daemon-wrapper-command-match-'),
  );
  try {
    return await fn(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    {} as unknown as DialogStore,
    'shared-daemon-reminder-wrapper-command-match.tsk',
    undefined,
    agentId,
  );
}

async function readProcessCommandLine(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function main(): Promise<void> {
  await withTempDir(async (sandboxDir) => {
    const wrapperPath = path.join(sandboxDir, 'pnpm.cjs');
    await fs.writeFile(wrapperPath, 'setInterval(() => {}, 10000);\n', 'utf-8');

    const child = spawn(process.execPath, [wrapperPath, 'dev'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    assert.equal(typeof pid, 'number', 'Expected wrapper process pid to exist');
    if (typeof pid !== 'number') {
      throw new Error('Expected wrapper process pid to exist');
    }
    child.unref();
    const actualCommandLine = await readProcessCommandLine(pid);
    assert.notEqual(actualCommandLine, '', 'Expected wrapper process command line to be readable');

    const reminder = materializeReminder({
      id: 'wrapcmd1',
      content: 'wrapper daemon reminder',
      owner: shellCmdReminderOwner,
      meta: {
        kind: 'daemon',
        pid,
        initialCommandLine: 'pnpm dev',
        daemonCommandLine: actualCommandLine,
        shell: 'bash',
        startTime: formatUnifiedTimestamp(new Date()),
        delete: { altInstruction: `stop_daemon({ "pid": ${String(pid)} })` },
        ...(process.platform === 'win32' ? {} : { processGroupId: pid }),
      },
      scope: 'agent_shared',
    });

    try {
      resetTrackedDaemonsForTests();
      const dialog = createDialog('tester');

      const update = await shellCmdReminderOwner.updateReminder(dialog, reminder);
      assert.equal(
        update.treatment,
        'drop',
        'Expected legacy wrapper-backed daemon reminder without runner metadata to be dropped',
      );

      const rendered = await shellCmdReminderOwner.renderReminder(dialog, reminder);
      if (!('content' in rendered) || typeof rendered.content !== 'string') {
        throw new Error('Expected rendered reminder to contain string content');
      }
      assert.match(rendered.content, /terminated|已结束/);
    } finally {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
      } catch {
        // best effort cleanup only
      }
    }
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
