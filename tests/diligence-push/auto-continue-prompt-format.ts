import assert from 'node:assert/strict';

import {
  formatDiligenceAutoContinuePrompt,
  formatSystemNoticePrefix,
} from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zhBody = '优先直接执行下一步，不要停在汇报。';
  const zhPrompt = formatDiligenceAutoContinuePrompt('zh', zhBody);
  assert.ok(
    zhPrompt.startsWith(formatSystemNoticePrefix('zh')),
    'zh diligence auto-continue prompt should start with the system-notice prefix',
  );
  assert.ok(
    zhPrompt.includes('不是新的用户诉求'),
    'zh diligence auto-continue prompt should say it is not a new user request',
  );
  assert.ok(
    zhPrompt.includes('不要只回复“收到/好的/我先想想/我会先整理一下”'),
    'zh diligence auto-continue prompt should forbid standalone acknowledgement replies',
  );
  assert.ok(
    zhPrompt.endsWith(zhBody),
    'zh diligence auto-continue prompt should preserve the original diligence body',
  );

  const enBody = 'Execute the next step directly instead of stopping at a report.';
  const enPrompt = formatDiligenceAutoContinuePrompt('en', enBody);
  assert.ok(
    enPrompt.startsWith(formatSystemNoticePrefix('en')),
    'en diligence auto-continue prompt should start with the system-notice prefix',
  );
  assert.ok(
    enPrompt.includes('not a new user request'),
    'en diligence auto-continue prompt should say it is not a new user request',
  );
  assert.ok(
    enPrompt.includes('do not reply with a standalone "acknowledged/ok'),
    'en diligence auto-continue prompt should forbid standalone acknowledgement replies',
  );
  assert.ok(
    enPrompt.endsWith(enBody),
    'en diligence auto-continue prompt should preserve the original diligence body',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
