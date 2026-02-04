import { formatReminderItemGuide } from 'dominds/shared/i18n/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zh = formatReminderItemGuide('zh', 2, '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 #2'), 'Expected zh reminder guide to include index');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');

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

  const en = formatReminderItemGuide('en', 2, 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER ITEM #2'), 'Expected en reminder guide to include index');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');

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

  const enEditExample = formatReminderItemGuide('en', 4, 'Managed content\n', {
    meta: { managedByTool: 'some_tool', edit: { updateExample: 'some_tool({ \"x\": 1 })' } },
  });
  assert(
    enEditExample.includes('some_tool({ "x": 1 })'),
    'Expected reminder meta edit.updateExample to be used (en)',
  );

  console.log('✓ Reminder formatting test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
