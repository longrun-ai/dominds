import assert from 'node:assert/strict';

import { DialogStore, RootDialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { materializeReminder } from '../../main/tool';
import { shellCmdReminderOwner } from '../../main/tools/os';

function createDialog(): RootDialog {
  return new RootDialog(
    new DialogStore(),
    'daemon-reminder-gone-exit-snapshot.tsk',
    undefined,
    'tester',
  );
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
    },
  });

  const result = await shellCmdReminderOwner.updateReminder(dialog, reminder);
  assert.equal(result.treatment, 'update', 'Expected missing daemon to finalize into exited state');
  if (result.treatment !== 'update') {
    throw new Error('Expected missing daemon to finalize into exited state');
  }
  assert.match(
    result.updatedContent,
    /🟡 pnpm dev 已退出（退出事件提示 \/ 确认看到后可删除）/,
    'Expected exited reminder to expose explicit exited phase summary',
  );
  assert.doesNotMatch(
    result.updatedContent,
    /🟢 pnpm dev 运行中（系统维护 \/ 实时真源 \/ 不可删除）/,
    'Expected exited snapshot to strip stale running phase summary from the retained snapshot body',
  );
  assert.match(
    result.updatedContent,
    /最后一次已知状态快照：\n后台进程 PID: 999999/,
    'Expected exited snapshot to retain daemon details after stripping the stale phase summary',
  );

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
