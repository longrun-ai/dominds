import assert from 'node:assert/strict';
import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { Team } from '../../main/team';
import type { Reminder } from '../../main/tool';
import { shellCmdReminderOwner, shellCmdTool, stopDaemonTool } from '../../main/tools/os';

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
  const pid = meta['pid'];
  assert.equal(typeof pid, 'number', 'Expected daemon reminder meta.pid to be a number');
  return pid;
}

async function main(): Promise<void> {
  setWorkLanguage('zh');
  const dialog = createDialog();
  const caller = {} as Team.Member;

  await shellCmdTool.call(dialog, caller, {
    command: `node -e "console.log('daemon-ready'); setInterval(() => {}, 10000)"`,
    timeoutSeconds: 1,
  });

  const reminder = dialog.reminders[0];
  const pid = requireDaemonPid(reminder);

  try {
    assert.equal(reminder?.owner, shellCmdReminderOwner);
    const rendered = await shellCmdReminderOwner.renderReminder(dialog, reminder!, 0);
    assert.equal(rendered.type, 'environment_msg');
    assert.equal(rendered.role, 'user');
    assert.match(rendered.content, /运行中后台进程状态 #1/);
    assert.match(rendered.content, /状态快照/);
    assert.match(rendered.content, /stdout 缓冲区快照/);
    assert.match(rendered.content, /daemon-ready/);
    assert.doesNotMatch(rendered.content, /请按需要检查/);
    assert.doesNotMatch(rendered.content, /Latest stdout/);
    assert.doesNotMatch(rendered.content, /Use stop_daemon/);
  } finally {
    await stopDaemonTool.call(dialog, caller, { pid });
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
