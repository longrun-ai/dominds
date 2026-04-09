import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import {
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

function requireMetaRecord(meta: unknown): Record<string, unknown> {
  assert.equal(typeof meta, 'object', 'Expected daemon reminder meta to exist');
  assert.notEqual(meta, null, 'Expected daemon reminder meta to be non-null');
  assert.equal(Array.isArray(meta), false, 'Expected daemon reminder meta to be a record');
  return meta as Record<string, unknown>;
}

function requireNumber(value: unknown, label: string): number {
  assert.equal(typeof value, 'number', `Expected ${label} to be a number`);
  if (typeof value !== 'number') {
    throw new Error(`Expected ${label} to be a number`);
  }
  return value;
}

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-shared-daemon-command-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function createDialog(agentId: string): RootDialog {
  return new RootDialog(
    {} as unknown as DialogStore,
    'shared-daemon-reminder-command-mismatch.tsk',
    undefined,
    agentId,
  );
}

function requireDaemonReminder(
  reminders: Awaited<ReturnType<RootDialog['listVisibleReminders']>>,
): (typeof reminders)[number] {
  const reminder = reminders.find(
    (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
  );
  assert.ok(reminder, 'Expected shellCmd daemon reminder to exist');
  return reminder;
}

function requireDaemonPid(
  reminder: Awaited<ReturnType<RootDialog['listVisibleReminders']>>[number],
): number {
  const meta = requireMetaRecord(reminder.meta);
  assert.equal(meta['kind'], 'daemon', 'Expected daemon reminder meta.kind to be daemon');
  return requireNumber(meta['pid'], 'daemon reminder meta.pid');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    registerReminderOwner(shellCmdReminderOwner);
    let daemonPid: number | undefined;
    try {
      const dialogA = createDialog('tester');
      const caller = {} as Team.Member;

      await shellCmdTool.call(dialogA, caller, {
        command: `node -e "setInterval(() => {}, 10000)"`,
        timeoutSeconds: 1,
      });

      const reminderA = requireDaemonReminder(await dialogA.listVisibleReminders());
      daemonPid = requireDaemonPid(reminderA);

      const sharedReminderPath = path.join(
        sandboxDir,
        '.dialogs',
        'reminders',
        'tester',
        `${reminderA.id}.json`,
      );
      const parsed = JSON.parse(await fs.readFile(sharedReminderPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const parsedMeta =
        typeof parsed['meta'] === 'object' &&
        parsed['meta'] !== null &&
        !Array.isArray(parsed['meta'])
          ? (parsed['meta'] as Record<string, unknown>)
          : null;
      assert.notEqual(parsedMeta, null, 'Expected persisted daemon reminder meta to exist');
      if (parsedMeta === null) {
        throw new Error('Expected persisted daemon reminder meta to exist');
      }
      assert.equal(
        typeof parsedMeta['daemonCommandLine'],
        'string',
        'Expected persisted daemon reminder to record daemonCommandLine',
      );
      parsedMeta['daemonCommandLine'] = 'echo definitely-not-the-original-command';
      await fs.writeFile(sharedReminderPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');

      resetTrackedDaemonsForTests();
      const dialogB = createDialog('tester');
      const stopOutput = (await stopDaemonTool.call(dialogB, caller, { pid: daemonPid })).content;
      assert.match(
        stopOutput,
        /No daemon process found|未找到/,
        'Expected restart recovery to reject PID-only match when command line no longer matches',
      );
    } finally {
      unregisterReminderOwner(shellCmdReminderOwner.name);
      if (daemonPid !== undefined && isProcessAlive(daemonPid)) {
        try {
          process.kill(daemonPid, 'SIGTERM');
        } catch {}
      }
    }
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
