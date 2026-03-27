import { formatReminderItemGuide } from '../../main/runtime/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zh = formatReminderItemGuide('zh', 2, '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 #2'), 'Expected zh reminder guide to include index');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');
  assert(
    zh.includes('我给自己的显眼提示'),
    'Expected zh reminder guide to describe plain reminders as conspicuous self-reminders',
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

  const zhToolManaged = formatReminderItemGuide('zh', 1, 'Managed content\n', {
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

  const zhPlanManager = formatReminderItemGuide('zh', 3, 'Managed content\n', {
    meta: { kind: 'plan', manager: { tool: 'some_tool' } },
  });
  assert(
    zhPlanManager.includes('some_tool'),
    'Expected reminder meta manager.tool to be used (zh)',
  );

  const zhUpdateInstruction = formatReminderItemGuide('zh', 4, 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' }, update: { altInstruction: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    zhUpdateInstruction.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta update.altInstruction to be used (zh)',
  );

  const zhDeleteExample = formatReminderItemGuide('zh', 6, 'Managed content\n', {
    meta: { delete: { altInstruction: 'stop_daemon({ "pid": 321 })' } },
  });
  assert(
    zhDeleteExample.includes('stop_daemon({ "pid": 321 })'),
    'Expected reminder meta delete.altInstruction to be used (zh)',
  );
  assert(
    !zhDeleteExample.includes('delete_reminder({ "reminder_no": 6 })'),
    'Expected reminder with meta delete.altInstruction not to suggest delete_reminder (zh)',
  );

  const zhMetaControlledUpdate = formatReminderItemGuide('zh', 7, 'Auto-managed content\n', {
    meta: {
      kind: 'pending_tellask',
      pendingCount: 0,
      update: { altInstruction: '等待系统自动刷新' },
    },
  });
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
      '如果我已确认这里只是清理噪音、并非要推进动作，可执行：delete_reminder({ "reminder_no": 7 })',
    ),
    'Expected zh zero-inflight pending-tellask guide to use optional noise-cleanup delete wording',
  );

  const zhPendingActiveGuard = formatReminderItemGuide('zh', 8, '进行中诉请内容\n', {
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
    !zhPendingActiveGuard.includes('delete_reminder({ "reminder_no": 8 })'),
    'Expected zh active pending-tellask guide not to suggest delete_reminder',
  );

  const zhContinuation = formatReminderItemGuide('zh', 5, '接续信息\n', {
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

  const en = formatReminderItemGuide('en', 2, 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER ITEM #2'), 'Expected en reminder guide to include index');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');
  assert(
    en.includes('my conspicuous self-reminder'),
    'Expected en reminder guide to describe plain reminders as self-reminders',
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

  const enToolManaged = formatReminderItemGuide('en', 3, 'Managed content\n', {
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
    !enToolManaged.includes('- Update: update_reminder'),
    'Expected en tool-managed reminder not to suggest update_reminder as the update action',
  );
  assert(
    enToolManaged.includes('(TOOL STATE)'),
    'Expected en tool-managed reminder to use tool-state framing',
  );

  const enUpdateInstruction = formatReminderItemGuide('en', 4, 'Managed content\n', {
    meta: { manager: { tool: 'some_tool' }, update: { altInstruction: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    enUpdateInstruction.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta update.altInstruction to be used (en)',
  );

  const enDeleteExample = formatReminderItemGuide('en', 6, 'Managed content\n', {
    meta: { delete: { altInstruction: 'stop_daemon({ "pid": 321 })' } },
  });
  assert(
    enDeleteExample.includes('stop_daemon({ "pid": 321 })'),
    'Expected reminder meta delete.altInstruction to be used (en)',
  );
  assert(
    !enDeleteExample.includes('delete_reminder({ "reminder_no": 6 })'),
    'Expected reminder with meta delete.altInstruction not to suggest delete_reminder (en)',
  );

  const enMetaControlledUpdate = formatReminderItemGuide('en', 7, 'Auto-managed content\n', {
    meta: {
      kind: 'pending_tellask',
      pendingCount: 0,
      update: { altInstruction: 'wait for system refresh' },
    },
  });
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
      'If I have confirmed this is only noise cleanup and not an action step, I may run: delete_reminder({ "reminder_no": 7 })',
    ),
    'Expected en zero-inflight pending-tellask guide to use optional noise-cleanup delete wording',
  );

  const enPendingActiveGuard = formatReminderItemGuide('en', 8, 'In-flight tellask content\n', {
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
  });
  assert(
    enPendingActiveGuard.includes(
      'There are still in-flight Tellasks; do not delete this reminder. Only a sessioned tellask can update that specific tellask assignment; a one-shot tellask cannot',
    ),
    'Expected en reminder guide to show active pending-tellask delete guard',
  );
  assert(
    !enPendingActiveGuard.includes('delete_reminder({ "reminder_no": 8 })'),
    'Expected en active pending-tellask guide not to suggest delete_reminder',
  );

  const enContinuation = formatReminderItemGuide('en', 5, 'Continuation details\n', {
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
