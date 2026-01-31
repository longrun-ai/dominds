import { formatReminderItemGuide } from 'dominds/shared/i18n/driver-messages';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const zh = formatReminderItemGuide('zh', 2, '保持缩进：\n  - A\n  - B\n');
  assert(zh.includes('提醒项 #2'), 'Expected zh reminder guide to include index');
  assert(zh.includes('保持缩进'), 'Expected zh reminder guide to include content');
  assert(zh.includes('\n  - A\n'), 'Expected zh reminder guide to preserve whitespace');

  const en = formatReminderItemGuide('en', 2, 'Keep indentation:\n  - A\n  - B\n');
  assert(en.includes('REMINDER ITEM #2'), 'Expected en reminder guide to include index');
  assert(en.includes('Keep indentation'), 'Expected en reminder guide to include content');

  console.log('✓ Reminder formatting test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
