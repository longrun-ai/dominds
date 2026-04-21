import {
  formatReminderContextGuide,
  formatReminderItemGuide,
} from '../../main/runtime/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zhContextGuide = formatReminderContextGuide('zh');
  assert(
    zhContextGuide.includes('当前可见提醒项的运行时上下文投影'),
    'Expected zh reminder context guide to explain runtime-added context projection',
  );
  assert(
    zhContextGuide.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected zh reminder context guide to explain separate Reminder widget presentation',
  );

  const zh = formatReminderItemGuide('zh', 'rem02abc', '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 [rem02abc]'), 'Expected zh reminder guide to include reminder id');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');
  assert(
    zh.includes('我给自己的显眼提示'),
    'Expected zh reminder guide to describe plain reminders as conspicuous self-reminders',
  );
  assert(
    zh.includes('Reminder 上下文投影条目：'),
    'Expected zh reminder guide to include a compact self-contained per-item projection note',
  );
  assert(
    !zh.includes('高优先级工作集'),
    'Expected zh reminder guide not to use work-queue framing',
  );
  assert(
    !zh.includes('快捷操作：'),
    'Expected zh reminder guide to avoid imperative quick-action label',
  );
  assert(!zh.includes('可选操作：'), 'Expected zh reminder guide to omit action section labels');
  assert(
    zh.includes('如果我要更新这条提醒项'),
    'Expected zh reminder guide to use conditional update wording',
  );

  const zhPersonal = formatReminderItemGuide('zh', 'rem09abc', '记住常用部署命令\n', {
    scope: 'personal',
  });
  assert(
    zhPersonal.includes('个人范围'),
    'Expected zh personal reminder guide to mark personal scope',
  );
  assert(
    zhPersonal.includes('在所有由我主理的后续对话里都会看到它'),
    'Expected zh personal reminder guide to explain cross-dialog persistence',
  );

  const zhToolManaged = formatReminderItemGuide('zh', 'rem01abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' } },
  });
  assert(
    zhToolManaged.includes('some_tool'),
    'Expected tool-managed reminder to mention management tool (zh)',
  );
  assert(
    !zhToolManaged.includes('- 更新：update_reminder'),
    'Expected tool-managed reminder not to suggest update_reminder as the update action (zh)',
  );
  assert(
    zhToolManaged.includes('工具状态'),
    'Expected tool-managed reminder to use neutral tool-state framing (zh)',
  );
  assert(
    zhToolManaged.includes('默认不在对外回复里专门确认、复述或总结它'),
    'Expected zh tool-managed reminder to discourage standalone acknowledgment',
  );
  assert(
    zhToolManaged.includes('Reminder 上下文投影条目：'),
    'Expected zh tool-managed reminder to include compact self-contained per-item projection note',
  );

  const zhUpdateInstruction = formatReminderItemGuide('zh', 'rem04abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' }, update: { altInstruction: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    zhUpdateInstruction.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta update.altInstruction to be used (zh)',
  );

  const zhDeleteExample = formatReminderItemGuide('zh', 'rem06abc', 'Managed content\n', {
    meta: { delete: { altInstruction: 'stop_daemon({ "pid": 321 })' } },
  });
  assert(
    zhDeleteExample.includes('stop_daemon({ "pid": 321 })'),
    'Expected reminder meta delete.altInstruction to be used (zh)',
  );
  assert(
    !zhDeleteExample.includes('delete_reminder({ "reminder_id": "rem06abc" })'),
    'Expected reminder with meta delete.altInstruction not to suggest delete_reminder (zh)',
  );

  const zhDaemonRunning = formatReminderItemGuide('zh', 'rem10abc', 'daemon running\n', {
    meta: {
      kind: 'daemon',
      update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
      delete: { altInstruction: 'stop_daemon({ "pid": 321 })' },
    },
  });
  assert(
    zhDaemonRunning.includes('get_daemon_output({ "pid": 321 })'),
    'Expected daemon reminder to guide updates via get_daemon_output (zh)',
  );
  assert(
    !zhDaemonRunning.includes('如果我要更新这条提醒项，可执行：update_reminder'),
    'Expected daemon reminder not to suggest update_reminder while running (zh)',
  );

  const zhDaemonCompleted = formatReminderItemGuide('zh', 'rem11abc', 'daemon exited\n', {
    meta: {
      kind: 'daemon',
      completed: true,
      update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
    },
  });
  assert(
    zhDaemonCompleted.includes('get_daemon_output({ "pid": 321 })'),
    'Expected completed daemon reminder to keep optional output inspection guidance (zh)',
  );
  assert(
    zhDaemonCompleted.includes('delete_reminder({ "reminder_id": "rem11abc" })'),
    'Expected completed daemon reminder to allow manual delete_reminder (zh)',
  );

  const zhMetaControlledUpdate = formatReminderItemGuide(
    'zh',
    'rem07abc',
    'Auto-managed content\n',
    {
      meta: {
        kind: 'pending_tellask',
        pendingCount: 0,
        update: { altInstruction: '等待系统自动刷新' },
      },
    },
  );
  assert(
    zhMetaControlledUpdate.includes('等待系统自动刷新'),
    'Expected reminder meta update.altInstruction to work without manager.tool (zh)',
  );
  assert(
    !zhMetaControlledUpdate.includes('如果我要更新这条提醒项，可执行：update_reminder'),
    'Expected meta-controlled reminder not to suggest update_reminder (zh)',
  );
  assert(
    zhMetaControlledUpdate.includes(
      '如果我已确认这里只是清理噪音、并非要推进动作，可执行：delete_reminder({ "reminder_id": "rem07abc" })',
    ),
    'Expected zh zero-inflight pending-tellask guide to use optional noise-cleanup delete wording',
  );

  const zhPendingActiveGuard = formatReminderItemGuide('zh', 'rem08abc', '进行中诉请内容\n', {
    meta: {
      update: {
        altInstruction: '只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
      },
      delete: {
        altInstruction:
          '当前仍有进行中诉请；不可删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
      },
    },
  });
  assert(
    zhPendingActiveGuard.includes(
      '当前仍有进行中诉请；不可删除。只有长线诉请能更新特定诉请的“任务安排”；一次性诉请没有这个通道',
    ),
    'Expected zh reminder guide to show active pending-tellask delete guard',
  );
  assert(
    !zhPendingActiveGuard.includes('delete_reminder({ "reminder_id": "rem08abc" })'),
    'Expected zh active pending-tellask guide not to suggest delete_reminder',
  );

  const zhContinuation = formatReminderItemGuide('zh', 'rem05abc', '接续信息\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    zhContinuation.includes('换程接续信息'),
    'Expected continuation reminder to use continuation label (zh)',
  );
  assert(
    zhContinuation.includes('不把它自动当成当前必须立刻执行的指令'),
    'Expected continuation reminder to clarify it is not an immediate command (zh)',
  );
  assert(
    zhContinuation.includes('进入新一程后，我的第一步就是以清醒头脑重新审视并整理更新'),
    'Expected continuation reminder to require new-course first-step cleanup (zh)',
  );

  const enContextGuide = formatReminderContextGuide('en');
  assert(
    enContextGuide.includes('visible reminders are runtime-added context projections'),
    'Expected en reminder context guide to explain runtime-added context projection',
  );
  assert(
    enContextGuide.includes(
      'the user sees these reminders through a separate Reminder widget/panel item',
    ),
    'Expected en reminder context guide to explain separate Reminder widget presentation',
  );

  const en = formatReminderItemGuide('en', 'rem02abc', 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER [rem02abc]'), 'Expected en reminder guide to include reminder id');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');
  assert(
    en.includes('my conspicuous self-reminder'),
    'Expected en reminder guide to describe plain reminders as self-reminders',
  );
  assert(
    en.includes('Reminder context projection item:'),
    'Expected en reminder guide to include a compact self-contained per-item projection note',
  );
  assert(
    !en.includes('HIGH-PRIORITY WORKING SET'),
    'Expected en reminder guide not to use work-queue framing',
  );
  assert(
    !en.includes('Optional actions:'),
    'Expected en reminder guide to omit action section labels',
  );
  assert(
    en.includes('If I need to update this reminder'),
    'Expected en reminder guide to use conditional update wording',
  );

  const enPersonal = formatReminderItemGuide('en', 'rem09abc', 'Remember the deploy command\n', {
    scope: 'personal',
  });
  assert(
    enPersonal.includes('PERSONAL SCOPE'),
    'Expected en personal reminder guide to mark personal scope',
  );
  assert(
    enPersonal.includes('I will keep seeing it in all later dialogs I lead'),
    'Expected en personal reminder guide to explain cross-dialog persistence',
  );

  const enToolManaged = formatReminderItemGuide('en', 'rem03abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' } },
  });
  assert(
    enToolManaged.includes('managed by tool some_tool'),
    'Expected en tool-managed reminder to mention management tool',
  );
  assert(
    enToolManaged.includes('should not explicitly acknowledge, restate, or summarize it'),
    'Expected en tool-managed reminder to discourage standalone acknowledgment',
  );
  assert(
    enToolManaged.includes('Reminder context projection item:'),
    'Expected en tool-managed reminder to include compact self-contained per-item projection note',
  );
  assert(
    !enToolManaged.includes('- Update: update_reminder'),
    'Expected en tool-managed reminder not to suggest update_reminder as the update action',
  );
  assert(
    enToolManaged.includes('(TOOL STATE)'),
    'Expected en tool-managed reminder to use tool-state framing',
  );

  const enUpdateInstruction = formatReminderItemGuide('en', 'rem04abc', 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' }, update: { altInstruction: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    enUpdateInstruction.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta update.altInstruction to be used (en)',
  );

  const enDeleteExample = formatReminderItemGuide('en', 'rem06abc', 'Managed content\n', {
    meta: { delete: { altInstruction: 'stop_daemon({ "pid": 321 })' } },
  });
  assert(
    enDeleteExample.includes('stop_daemon({ "pid": 321 })'),
    'Expected reminder meta delete.altInstruction to be used (en)',
  );
  assert(
    !enDeleteExample.includes('delete_reminder({ "reminder_id": "rem06abc" })'),
    'Expected reminder with meta delete.altInstruction not to suggest delete_reminder (en)',
  );

  const enDaemonRunning = formatReminderItemGuide('en', 'rem10abc', 'daemon running\n', {
    meta: {
      kind: 'daemon',
      update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
      delete: { altInstruction: 'stop_daemon({ "pid": 321 })' },
    },
  });
  assert(
    enDaemonRunning.includes('get_daemon_output({ "pid": 321 })'),
    'Expected daemon reminder to guide updates via get_daemon_output (en)',
  );
  assert(
    !enDaemonRunning.includes('If I need to update this reminder, run: update_reminder'),
    'Expected daemon reminder not to suggest update_reminder while running (en)',
  );

  const enDaemonCompleted = formatReminderItemGuide('en', 'rem11abc', 'daemon exited\n', {
    meta: {
      kind: 'daemon',
      completed: true,
      update: { altInstruction: 'get_daemon_output({ "pid": 321 })' },
    },
  });
  assert(
    enDaemonCompleted.includes('get_daemon_output({ "pid": 321 })'),
    'Expected completed daemon reminder to keep optional output inspection guidance (en)',
  );
  assert(
    enDaemonCompleted.includes('delete_reminder({ "reminder_id": "rem11abc" })'),
    'Expected completed daemon reminder to allow manual delete_reminder (en)',
  );

  const enMetaControlledUpdate = formatReminderItemGuide(
    'en',
    'rem07abc',
    'Auto-managed content\n',
    {
      meta: {
        kind: 'pending_tellask',
        pendingCount: 0,
        update: { altInstruction: 'wait for system refresh' },
      },
    },
  );
  assert(
    enMetaControlledUpdate.includes('wait for system refresh'),
    'Expected reminder meta update.altInstruction to work without manager.tool (en)',
  );
  assert(
    !enMetaControlledUpdate.includes('If I need to update this reminder, run: update_reminder'),
    'Expected meta-controlled reminder not to suggest update_reminder (en)',
  );
  assert(
    enMetaControlledUpdate.includes(
      'If I have confirmed this is only noise cleanup and not an action step, I may run: delete_reminder({ "reminder_id": "rem07abc" })',
    ),
    'Expected en zero-inflight pending-tellask guide to use optional noise-cleanup delete wording',
  );

  const enPendingActiveGuard = formatReminderItemGuide(
    'en',
    'rem08abc',
    'In-flight tellask content\n',
    {
      meta: {
        update: {
          altInstruction:
            'only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
        delete: {
          altInstruction:
            'There are still in-flight Tellasks; do not delete this reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
        },
      },
    },
  );
  assert(
    enPendingActiveGuard.includes(
      'There are still in-flight Tellasks; do not delete this reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
    ),
    'Expected en reminder guide to show active pending-tellask delete guard',
  );
  assert(
    !enPendingActiveGuard.includes('delete_reminder({ "reminder_id": "rem08abc" })'),
    'Expected en active pending-tellask guide not to suggest delete_reminder',
  );

  const enContinuation = formatReminderItemGuide('en', 'rem05abc', 'Continuation details\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    enContinuation.includes('(CONTINUATION PACKAGE)'),
    'Expected continuation reminder to use continuation label (en)',
  );
  assert(
    enContinuation.includes('not as an automatic must-do command'),
    'Expected continuation reminder to clarify it is not an immediate command (en)',
  );
  assert(
    enContinuation.includes('my first step is to review and rewrite this with a clear head'),
    'Expected continuation reminder to require new-course first-step cleanup (en)',
  );

  console.log('✓ Reminder formatting test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
