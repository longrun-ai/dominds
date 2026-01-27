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
    zh.includes('本轮之后还剩 4 轮'),
    'zh guide should include countdown number (4) in copy',
  );
  assert.ok(!zh.includes('轮次'), 'zh guide should avoid “轮次”');

  const en = formatUserFacingContextHealthV3RemediationGuide('en', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 0,
    promptsTotal: 5,
  });
  assert.ok(en.includes('Countdown:'), 'en guide should mention Countdown');
  assert.ok(
    en.includes('0 turns remaining after this'),
    'en guide should include countdown number (0)',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
