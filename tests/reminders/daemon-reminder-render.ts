import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import type { Reminder } from '../../main/tool';
import { shellCmdReminderOwner, shellCmdTool, stopDaemonTool } from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

function requireMetaRecord(meta: Reminder['meta']): Record<string, unknown> {
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

function requireObjectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `Expected ${label} to exist`);
  assert.notEqual(value, null, `Expected ${label} to be non-null`);
  assert.equal(Array.isArray(value), false, `Expected ${label} to be a record`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function createDialog(): MainDialog {
  return new MainDialog(
    {} as unknown as DialogStore,
    'daemon-reminder-render.tsk',
    undefined,
    'tester',
  );
}

function requireDaemonPid(reminder: Reminder | undefined): number {
  assert.ok(reminder, 'Expected daemon reminder to be created');
  const meta = requireMetaRecord(reminder.meta);
  assert.equal(meta['kind'], 'daemon', 'Expected daemon reminder meta.kind to be daemon');
  const pid = requireNumber(meta['pid'], 'daemon reminder meta.pid');
  const deleteMeta = requireObjectRecord(meta['delete'], 'daemon reminder meta.delete');
  assert.equal(
    deleteMeta['altInstruction'],
    `stop_daemon({ "pid": ${String(pid)} })`,
    'Expected daemon reminder meta.delete.altInstruction to point to stop_daemon',
  );
  return pid;
}

async function main(): Promise<void> {
  setWorkLanguage('zh');
  registerReminderOwner(shellCmdReminderOwner);
  try {
    const dialog = createDialog();
    const caller = {} as Team.Member;

    await shellCmdTool.call(dialog, caller, {
      command: `node -e "console.log('daemon-ready'); setInterval(() => {}, 10000)"`,
      timeoutSeconds: 1,
    });

    const reminder = (await dialog.listVisibleReminders()).find(
      (candidate) => candidate.owner?.name === shellCmdReminderOwner.name,
    );
    const pid = requireDaemonPid(reminder);

    try {
      const rendered = await shellCmdReminderOwner.renderReminder(dialog, reminder!);
      if (!('content' in rendered) || typeof rendered.content !== 'string') {
        throw new Error('Expected daemon reminder render output to carry string content');
      }
      assert.equal(rendered.type, 'environment_msg');
      assert.equal(rendered.role, 'user');
      assert.match(rendered.content, /守护进程生命周期提醒 \[/);
      assert.match(rendered.content, /当前运行环境中 daemon 仍在运行/);
      assert.match(
        rendered.content,
        /🟢 node -e "console\.log\('daemon-ready'\); setInterval\(\(\) => \{\}, 10000\)" 运行中/,
      );
      assert.match(rendered.content, /状态快照/);
      const stderrIndex = rendered.content.indexOf('stderr 缓冲区快照');
      const stdoutIndex = rendered.content.indexOf('stdout 缓冲区快照');
      assert.ok(stderrIndex >= 0);
      assert.ok(stdoutIndex >= 0);
      assert.ok(stderrIndex < stdoutIndex);
      assert.match(rendered.content, /stdout 缓冲区快照/);
      assert.match(rendered.content, /daemon-ready/);
      assert.match(rendered.content, /系统维护 \/ 实时真源 \/ 不可删除/);
      assert.match(rendered.content, /禁止做任何用户可见回应/);
      assert.match(rendered.content, /禁止单独发送“静默吸收”“已收到”等占位语句/);
      assert.doesNotMatch(rendered.content, /请按需要检查/);
      assert.doesNotMatch(rendered.content, /Latest stdout/);
      assert.doesNotMatch(rendered.content, /Use stop_daemon/);
    } finally {
      await stopDaemonTool.call(dialog, caller, { pid });
    }
  } finally {
    unregisterReminderOwner(shellCmdReminderOwner.name);
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
