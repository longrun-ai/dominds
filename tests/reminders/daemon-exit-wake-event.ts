import assert from 'node:assert/strict';

import { DialogStore, MainDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { materializeReminder } from '../../main/tool';
import { shellCmdReminderOwner } from '../../main/tools/os';

function createDialog(): MainDialog {
  return new MainDialog(new DialogStore(), 'daemon-exit-wake-event.tsk', undefined, 'tester');
}

async function main(): Promise<void> {
  setWorkLanguage('zh');
  const dialog = createDialog();
  const reminder = materializeReminder({
    id: 'daemon001',
    content: `🟢 pnpm dev 运行中（系统维护 / 实时真源 / 不可删除）

后台进程 PID: 999999
命令: pnpm dev
Shell: bash
生命周期状态: 运行中
已运行: 5s
启动时间: 2026-04-16 20:00:00`,
    owner: shellCmdReminderOwner,
    meta: {
      kind: 'daemon',
      pid: 999999,
      runnerEndpoint: 'unix:/tmp/dominds-missing-runner.sock',
      initialCommandLine: 'pnpm dev',
      daemonCommandLine: 'pnpm dev',
      shell: 'bash',
      startTime: '2026-04-16T12:00:00.000Z',
      originDialogId: 'dialog-self',
      originRootId: 'dialog-root',
    },
  });

  const first = await shellCmdReminderOwner.waitForReminderWakeEvent?.(
    dialog,
    [reminder],
    new AbortController().signal,
  );
  assert.ok(first && !Array.isArray(first), 'Expected one daemon exit wake event');
  if (!first || Array.isArray(first)) {
    throw new Error('Expected one daemon exit wake event');
  }
  assert.equal(first.reminderId, 'daemon001');
  assert.equal(first.eventId, 'shellCmd:daemonExited:999999:2026-04-16T12:00:00.000Z');
  assert.match(first.content, /^【系统提示】\n后台进程已退出。/);
  assert.match(first.updatedContent, /🟡 pnpm dev 已退出/);
  assert.equal(typeof first.updatedMeta, 'object');
  assert.notEqual(first.updatedMeta, null);
  assert.equal(Array.isArray(first.updatedMeta), false);
  if (
    typeof first.updatedMeta !== 'object' ||
    first.updatedMeta === null ||
    Array.isArray(first.updatedMeta)
  ) {
    throw new Error('Expected updatedMeta object');
  }
  assert.equal(first.updatedMeta['completed'], true);
  assert.equal(first.updatedMeta['exitWakeEventId'], first.eventId);
  assert.equal(typeof first.updatedMeta['exitWakeNotifiedAt'], 'string');
  assert.equal(first.updatedMeta['originRootId'], 'dialog-root');

  const deliveredReminder = materializeReminder({
    id: reminder.id,
    content: first.updatedContent ?? reminder.content,
    owner: shellCmdReminderOwner,
    meta: first.updatedMeta,
  });
  const second = await shellCmdReminderOwner.waitForReminderWakeEvent?.(
    dialog,
    [deliveredReminder],
    new AbortController().signal,
  );
  assert.equal(second, null, 'Delivered daemon exit wake event must not repeat');

  const alreadyCompletedReminder = materializeReminder({
    id: 'daemon002',
    content: first.updatedContent ?? reminder.content,
    owner: shellCmdReminderOwner,
    meta: {
      kind: 'daemon',
      pid: 999998,
      runnerEndpoint: 'unix:/tmp/dominds-missing-runner-2.sock',
      initialCommandLine: 'pnpm test',
      daemonCommandLine: 'pnpm test',
      shell: 'bash',
      startTime: '2026-04-16T12:00:01.000Z',
      completed: true,
    },
  });
  const staleCompleted = await shellCmdReminderOwner.waitForReminderWakeEvent?.(
    dialog,
    [alreadyCompletedReminder],
    new AbortController().signal,
  );
  assert.equal(staleCompleted, null, 'Already-completed daemon reminders must not wake later');

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
