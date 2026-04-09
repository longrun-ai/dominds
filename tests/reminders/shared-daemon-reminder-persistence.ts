import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import type { Team } from '../../main/team';
import {
  getDaemonOutputTool,
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
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-shared-daemon-reminder-'));
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
    'shared-daemon-reminder-persistence.tsk',
    undefined,
    agentId,
  );
}

function requireDaemonPid(
  reminder: ReturnType<RootDialog['listVisibleReminders']> extends Promise<infer T>
    ? T extends Array<infer U>
      ? U | undefined
      : never
    : never,
): number {
  assert.ok(reminder, 'Expected daemon reminder to be present');
  const meta = requireMetaRecord(reminder.meta);
  assert.equal(meta['kind'], 'daemon', 'Expected daemon reminder meta.kind to be daemon');
  return requireNumber(meta['pid'], 'daemon reminder meta.pid');
}

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    registerReminderOwner(shellCmdReminderOwner);
    try {
      const dialogA = createDialog('tester');
      const caller = {} as Team.Member;

      await shellCmdTool.call(dialogA, caller, {
        command: `node -e "console.log('daemon-ready'); console.error('daemon-err'); setInterval(() => {}, 10000)"`,
        timeoutSeconds: 1,
      });

      const visibleA = await dialogA.listVisibleReminders();
      assert.equal(
        visibleA.length,
        1,
        'Expected daemon reminder to be shared-visible in origin dialog',
      );
      const reminderA = visibleA.find(
        (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
      );
      const pid = requireDaemonPid(reminderA);

      assert.ok(reminderA, 'Expected daemon reminder to exist in origin dialog');
      const sharedReminderPath = path.join(
        sandboxDir,
        '.dialogs',
        'reminders',
        'tester',
        `${reminderA.id}.json`,
      );
      const raw = await fs.readFile(sharedReminderPath, 'utf-8');
      assert.match(raw, /"kind": "daemon"/);
      assert.match(raw, /"scope": "agent_shared"/);
      assert.match(raw, /"ownerName": "shellCmd"/);
      assert.match(raw, /"runnerPid": /);
      assert.match(raw, /"runnerEndpoint": /);
      assert.match(raw, /"initialCommandLine": /);
      assert.match(raw, /"daemonCommandLine": /);
      assert.doesNotMatch(raw, /"command": /);

      const dialogB = createDialog('tester');
      const visibleB = await dialogB.listVisibleReminders();
      const reminderB = visibleB.find(
        (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
      );
      assert.equal(
        reminderB?.id,
        reminderA?.id,
        'Expected another dialog of the same agent to see the same shared reminder id',
      );

      resetTrackedDaemonsForTests();
      const reminderAfterRestart = (await dialogB.listVisibleReminders()).find(
        (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
      );
      assert.equal(
        reminderAfterRestart?.id,
        reminderA?.id,
        'Expected shared reminder to survive in-memory daemon registry reset',
      );
      const rendered = await shellCmdReminderOwner.renderReminder(dialogB, reminderAfterRestart!);
      if (!('content' in rendered) || typeof rendered.content !== 'string') {
        throw new Error('Expected rendered daemon reminder to carry string content');
      }
      assert.match(rendered.content, /PID/);
      assert.match(rendered.content, /daemon-ready/);

      const outputAfterRestart = (await getDaemonOutputTool.call(dialogB, caller, { pid })).content;
      assert.match(outputAfterRestart, /stdout/);
      assert.match(outputAfterRestart, /stderr/);
      assert.match(outputAfterRestart, /daemon-ready/);
      assert.match(outputAfterRestart, /daemon-err/);

      const stopOutput = (await stopDaemonTool.call(dialogB, caller, { pid })).content;
      assert.match(stopOutput, /stopped|已停止/);

      const remaining = await dialogB.listVisibleReminders();
      assert.equal(remaining.length, 0, 'Expected shared daemon reminder to disappear after stop');
    } finally {
      unregisterReminderOwner(shellCmdReminderOwner.name);
    }
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
