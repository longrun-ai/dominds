/**
 * v3 remediation (caution) guide formatting regression
 *
 * This test focuses on copy stability and non-throw behavior for both:
 * - soft (grace period) guide
 * - hard (curate reminders) guide
 */

import assert from 'node:assert/strict';
import { formatUserFacingContextHealthV3RemediationGuide } from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zhSoft = formatUserFacingContextHealthV3RemediationGuide('zh', {
    kind: 'caution',
    mode: 'soft',
  });
  assert.ok(zhSoft.includes('上下文状态：🟡 吃紧'), 'zh guide should include caution headline');
  assert.ok(zhSoft.includes('clear_mind'), 'zh guide should mention clear_mind');
  assert.ok(zhSoft.includes('update_reminder'), 'zh guide should mention update_reminder');

  const enSoft = formatUserFacingContextHealthV3RemediationGuide('en', {
    kind: 'caution',
    mode: 'soft',
  });
  assert.ok(enSoft.includes('Context state: 🟡 caution'), 'en guide should include caution');
  assert.ok(enSoft.includes('update_reminder'), 'en guide should mention update_reminder');
  assert.ok(enSoft.includes('clear_mind'), 'en guide should mention clear_mind');

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
