/**
 * v3 remediation (critical) countdown message formatting regression
 *
 * The actual countdown/auto-clear behavior is exercised in runtime. Here we ensure:
 * - guide text renders without throwing
 * - countdown number is reflected in output
 * - copy uses "提醒项" and "新一轮/新回合" (not "轮次") in zh
 */

import assert from 'node:assert/strict';
import { formatUserFacingContextHealthV3RemediationGuide } from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zh = formatUserFacingContextHealthV3RemediationGuide('zh', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 4,
    promptsTotal: 5,
  });

  assert.ok(zh.includes('提醒项'), 'zh guide should mention reminders as “提醒项”');
  assert.ok(zh.includes('新一轮/新回合'), 'zh guide should use “新一轮/新回合” phrasing');
  assert.ok(
    zh.includes('最多再提醒你 4 次'),
    'zh guide should include reminder countdown number (4) in copy',
  );
  assert.ok(!zh.includes('轮次'), 'zh guide should avoid “轮次”');

  const en = formatUserFacingContextHealthV3RemediationGuide('en', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 0,
    promptsTotal: 5,
  });
  assert.ok(en.includes('Context state: 🔴 critical'), 'en guide should include critical headline');
  assert.ok(
    en.includes('at most 0 more time'),
    'en guide should include reminder countdown number (0)',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
