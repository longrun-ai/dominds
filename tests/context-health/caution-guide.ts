/**
 * v3 remediation (caution) guide formatting regression
 *
 * This test focuses on copy stability and non-throw behavior for both:
 * - soft (grace period) guide
 * - hard (curate reminders) guide
 */

import assert from 'node:assert/strict';
import { formatAgentFacingContextHealthV3RemediationGuide } from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zhSoft = formatAgentFacingContextHealthV3RemediationGuide('zh', {
    kind: 'caution',
    mode: 'soft',
  });
  assert.ok(zhSoft.includes('上下文状态：🟡 吃紧'), 'zh guide should include caution headline');
  assert.ok(zhSoft.includes('clear_mind'), 'zh guide should mention clear_mind');
  assert.ok(zhSoft.includes('update_reminder'), 'zh guide should mention update_reminder');
  assert.ok(
    zhSoft.includes('多条粗略提醒项'),
    'zh guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(
    !zhSoft.includes('头脑还清楚'),
    'zh guide should avoid subjective self-assessment wording',
  );

  const enSoft = formatAgentFacingContextHealthV3RemediationGuide('en', {
    kind: 'caution',
    mode: 'soft',
  });
  assert.ok(enSoft.includes('Context state: 🟡 caution'), 'en guide should include caution');
  assert.ok(enSoft.includes('update_reminder'), 'en guide should mention update_reminder');
  assert.ok(enSoft.includes('clear_mind'), 'en guide should mention clear_mind');
  assert.ok(
    enSoft.includes('rough multi-reminder carry-over is acceptable'),
    'en guide should allow rough multi-reminder bridge during remediation',
  );
  assert.ok(
    !enSoft.includes('still clear-headed'),
    'en guide should avoid subjective self-assessment wording',
  );
  assert.ok(
    enSoft.includes('do not switch early into “clear-headed continuation-package review” mode'),
    'en guide should explicitly forbid early new-course review while still in the current course',
  );
  assert.ok(
    enSoft.includes('that is the first step only after the system actually starts the new course'),
    'en guide should pin the mandatory review step to the system-started new course',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
