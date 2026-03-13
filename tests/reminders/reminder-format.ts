import { formatReminderItemGuide } from 'dominds/shared/i18n/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zh = formatReminderItemGuide('zh', 2, '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 #2'), 'Expected zh reminder guide to include index');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');
  assert(
    zh.includes('显眼提示'),
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
    zh.includes('如需更新此提醒项'),
    'Expected zh reminder guide to use conditional update wording',
  );

  const zhToolManaged = formatReminderItemGuide('zh', 1, 'Managed content\n', {
    meta: { managedByTool: 'some_tool' },
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

  const zhLegacyViaSource = formatReminderItemGuide('zh', 3, 'Legacy content\n', {
    meta: { kind: 'plan', source: 'some_tool' },
  });
  assert(
    zhLegacyViaSource.includes('some_tool'),
    'Expected legacy reminder with meta.source to infer management tool (zh)',
  );

  const zhEditExample = formatReminderItemGuide('zh', 4, 'Managed content\n', {
    meta: { managedByTool: 'some_tool', edit: { updateExample: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    zhEditExample.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta edit.updateExample to be used (zh)',
  );

  const zhContinuation = formatReminderItemGuide('zh', 5, '接续信息\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    zhContinuation.includes('换程接续信息'),
    'Expected continuation reminder to use continuation label (zh)',
  );
  assert(
    zhContinuation.includes('不自动等于当前必须立刻执行的指令'),
    'Expected continuation reminder to clarify it is not an immediate command (zh)',
  );
  assert(
    zhContinuation.includes('进入新一程后，第一步就要以清醒头脑重新审视并整理更新'),
    'Expected continuation reminder to require new-course first-step cleanup (zh)',
  );

  const en = formatReminderItemGuide('en', 2, 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER ITEM #2'), 'Expected en reminder guide to include index');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');
  assert(
    en.includes('conspicuous reminder to yourself'),
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
    en.includes('If you need to update this reminder'),
    'Expected en reminder guide to use conditional update wording',
  );

  const enToolManaged = formatReminderItemGuide('en', 3, 'Managed content\n', {
    meta: { managedByTool: 'some_tool' },
  });
  assert(
    enToolManaged.includes('managed by tool some_tool'),
    'Expected en tool-managed reminder to mention management tool',
  );
  assert(
    !enToolManaged.includes('- Update: update_reminder'),
    'Expected en tool-managed reminder not to suggest update_reminder as the update action',
  );
  assert(
    enToolManaged.includes('(TOOL STATE)'),
    'Expected en tool-managed reminder to use tool-state framing',
  );

  const enEditExample = formatReminderItemGuide('en', 4, 'Managed content\n', {
    meta: { managedByTool: 'some_tool', edit: { updateExample: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    enEditExample.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta edit.updateExample to be used (en)',
  );

  const enContinuation = formatReminderItemGuide('en', 5, 'Continuation details\n', {
    meta: { kind: 'continuation_package', createdBy: 'clear_mind' },
  });
  assert(
    enContinuation.includes('(CONTINUATION PACKAGE)'),
    'Expected continuation reminder to use continuation label (en)',
  );
  assert(
    enContinuation.includes('not an automatic must-do command'),
    'Expected continuation reminder to clarify it is not an immediate command (en)',
  );
  assert(
    enContinuation.includes('your first step is to review and rewrite this with a clear head'),
    'Expected continuation reminder to require new-course first-step cleanup (en)',
  );

  console.log('✓ Reminder formatting test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
