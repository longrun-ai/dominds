import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DialogStore, MainDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import {
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  shellCmdTool,
  stopDaemonTool,
} from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { daemonScriptShell, withTempCwd, writeDaemonScriptCommand } from './daemon-test-utils';

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

function createDialog(agentId: string): MainDialog {
  return new MainDialog(
    new DialogStore(),
    'shared-daemon-reminder-command-mismatch.tsk',
    undefined,
    agentId,
  );
}

function requireDaemonReminder(
  reminders: Awaited<ReturnType<MainDialog['listVisibleReminders']>>,
): (typeof reminders)[number] {
  const reminder = reminders.find(
    (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
  );
  assert.ok(reminder, 'Expected shellCmd daemon reminder to exist');
  return reminder;
}

function requireDaemonPid(
  reminder: Awaited<ReturnType<MainDialog['listVisibleReminders']>>[number],
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
  await withTempCwd('dominds-shared-daemon-command-', async (sandboxDir) => {
    registerReminderOwner(shellCmdReminderOwner);
    let daemonPid: number | undefined;
    try {
      const dialogA = createDialog('tester');
      const caller = {} as Team.Member;

      const command = await writeDaemonScriptCommand(
        sandboxDir,
        'long-running-daemon.js',
        `
setInterval(() => {}, 10000);
`,
        `while ($true) { Start-Sleep -Seconds 10 }`,
      );
      await shellCmdTool.call(dialogA, caller, {
        command,
        shell: daemonScriptShell(),
        timeoutSeconds: 1,
      });

      const reminderA = requireDaemonReminder(await dialogA.listVisibleReminders());
      daemonPid = requireDaemonPid(reminderA);

      const sharedReminderPath = path.join(
        sandboxDir,
        '.dialogs',
        'reminders',
        'agents',
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
