import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import type { Reminder } from '../../main/tool';
import { shellCmdReminderOwner, shellCmdTool, stopDaemonTool } from '../../main/tools/os';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';

function createDialog(): RootDialog {
  return new RootDialog(
    {} as unknown as DialogStore,
    'daemon-reminder-render.tsk',
    undefined,
    'tester',
  );
}

function requireDaemonPid(reminder: Reminder | undefined): number {
  assert.ok(reminder, 'Expected daemon reminder to be created');
  const meta = reminder.meta;
  assert.equal(typeof meta, 'object', 'Expected daemon reminder meta to exist');
  assert.notEqual(meta, null, 'Expected daemon reminder meta to be non-null');
  assert.equal(Array.isArray(meta), false, 'Expected daemon reminder meta to be a record');
  assert.equal(meta['kind'], 'daemon', 'Expected daemon reminder meta.kind to be daemon');
  const pid = meta['pid'];
  assert.equal(typeof pid, 'number', 'Expected daemon reminder meta.pid to be a number');
  const deleteMeta = meta['delete'];
  assert.equal(typeof deleteMeta, 'object', 'Expected daemon reminder meta.delete to exist');
  assert.notEqual(deleteMeta, null, 'Expected daemon reminder meta.delete to be non-null');
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
      assert.equal(rendered.type, 'environment_msg');
      assert.equal(rendered.role, 'user');
      assert.match(rendered.content, /运行中后台进程状态 \[/);
      assert.match(rendered.content, /状态快照/);
      assert.match(rendered.content, /stdout 缓冲区快照/);
      assert.match(rendered.content, /daemon-ready/);
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
