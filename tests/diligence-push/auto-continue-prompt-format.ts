import assert from 'node:assert/strict';

import {
  formatDiligenceAutoContinuePrompt,
  formatSideDialogDiligenceAutoContinuePrompt,
  formatSystemNoticePrefix,
} from '../../main/runtime/driver-messages';

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

  const fixedNow = new Date(2026, 4, 10, 17, 56, 21);
  for (const variant of [0, 1, 2] as const) {
    const zhSidePrompt = formatSideDialogDiligenceAutoContinuePrompt('zh', {
      now: fixedNow,
      tellaskContent: '请读取文件并返回完整结果。',
      replyToolName: 'replyTellaskSessionless',
      variant,
    });
    assert.match(zhSidePrompt, /2026 年 05 月 10 日 17 时 56 分 21 秒/);
    assert.match(zhSidePrompt, /replyTellaskSessionless\(\{ replyContent \}\)/);
    assert.match(zhSidePrompt, /请读取文件并返回完整结果。/);

    const enSidePrompt = formatSideDialogDiligenceAutoContinuePrompt('en', {
      now: fixedNow,
      tellaskContent: 'Read the files and return the complete output.',
      replyToolName: 'replyTellaskBack',
      variant,
    });
    assert.match(enSidePrompt, /2026-05-10 17:56:21/);
    assert.match(enSidePrompt, /replyTellaskBack\(\{ replyContent \}\)/);
    assert.match(enSidePrompt, /Read the files and return the complete output\./);
  }

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
