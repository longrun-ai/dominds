/**
 * v3 remediation (critical) countdown message formatting regression
 *
 * The actual countdown/auto-clear behavior is exercised in runtime. Here we ensure:
 * - guide text renders without throwing
 * - countdown number is reflected in output
 * - copy uses "提醒项" and "新一程对话" (not "轮次") in zh
 */

import assert from 'node:assert/strict';
import { formatAgentFacingContextHealthV3RemediationGuide } from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zh = formatAgentFacingContextHealthV3RemediationGuide('zh', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 4,
    promptsTotal: 5,
  });

  assert.ok(zh.includes('提醒项'), 'zh guide should mention reminders as “提醒项”');
  assert.ok(zh.includes('新一程对话'), 'zh guide should use “新一程对话” phrasing');
  assert.ok(
    zh.includes('多条粗略提醒项'),
    'zh guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(
    zh.includes('最多再提醒你 4 次'),
    'zh guide should include reminder countdown number (4) in copy',
  );
  assert.ok(!zh.includes('轮次'), 'zh guide should avoid “轮次”');

  const en = formatAgentFacingContextHealthV3RemediationGuide('en', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 0,
    promptsTotal: 5,
  });
  assert.ok(en.includes('Context state: 🔴 critical'), 'en guide should include critical headline');
  assert.ok(
    en.includes('multiple rough reminders'),
    'en guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(
    en.includes('remind you 0 more time'),
    'en guide should include reminder countdown number (0) in copy',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
