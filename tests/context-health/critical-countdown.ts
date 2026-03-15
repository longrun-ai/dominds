/**
 * v3 remediation (critical) countdown message formatting regression
 *
 * The actual countdown/auto-clear behavior is exercised in runtime. Here we ensure:
 * - guide text renders without throwing
 * - countdown number is reflected in output
 * - copy uses "提醒项" and "新一程对话" (not "轮次") in zh
 */

import assert from 'node:assert/strict';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatNewCourseStartPrompt,
  formatSystemNoticePrefix,
} from '../../main/shared/i18n/driver-messages';

async function main(): Promise<void> {
  const zh = formatAgentFacingContextHealthV3RemediationGuide('zh', {
    kind: 'critical',
    mode: 'countdown',
    promptsRemainingAfterThis: 4,
    promptsTotal: 5,
  });

  assert.ok(zh.includes('提醒项'), 'zh guide should mention reminders as “提醒项”');
  assert.ok(zh.includes('不是新的用户诉求'), 'zh guide should say it is not a new user request');
  assert.ok(
    zh.includes('不要只回复“收到/好的/我先整理提醒项”'),
    'zh guide should forbid standalone acknowledgement replies',
  );
  assert.ok(zh.includes('新一程对话'), 'zh guide should use “新一程对话” phrasing');
  assert.ok(
    zh.includes('多条粗略提醒项'),
    'zh guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(!zh.includes('已经发乱'), 'zh guide should avoid subjective self-assessment wording');
  assert.ok(
    zh.includes('纠正偏激/失真思路'),
    'zh guide should require correcting distorted bridge notes in the new course',
  );
  assert.ok(
    zh.includes('不要提前做“新一程清醒复核”'),
    'zh guide should explicitly forbid early new-course cleanup during critical remediation',
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
    en.includes('not a new user request'),
    'en guide should say it is not a new user request',
  );
  assert.ok(
    en.includes('do not reply with a standalone "acknowledged/ok'),
    'en guide should forbid standalone acknowledgement replies',
  );
  assert.ok(
    en.includes('multiple rough reminders'),
    'en guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(
    !en.includes('if you can still think clearly'),
    'en guide should avoid subjective self-assessment wording',
  );
  assert.ok(
    en.includes('correcting biased or distorted bridge notes'),
    'en guide should require correcting distorted bridge notes in the new course',
  );
  assert.ok(
    en.includes('do not start the new-course cleanup early'),
    'en guide should explicitly forbid early new-course cleanup during critical remediation',
  );
  assert.ok(
    en.includes('remind you 0 more time'),
    'en guide should include reminder countdown number (0) in copy',
  );

  const zhNewCoursePrompt = formatNewCourseStartPrompt('zh', {
    nextCourse: 3,
    source: 'critical_auto_clear',
  });
  assert.ok(
    zhNewCoursePrompt.startsWith(formatSystemNoticePrefix('zh')),
    'zh critical new-course prompt should start with the system-notice prefix',
  );
  assert.ok(
    zhNewCoursePrompt.includes('现在已经进入新一程'),
    'zh critical new-course prompt should explicitly mark the new course boundary',
  );
  assert.ok(
    zhNewCoursePrompt.includes('不是新的用户诉求'),
    'zh critical new-course prompt should say it is not a new user request',
  );
  assert.ok(
    zhNewCoursePrompt.includes('不要只回复“收到/好的/我会先整理提醒项”'),
    'zh critical new-course prompt should forbid standalone acknowledgement replies',
  );
  assert.ok(
    zhNewCoursePrompt.includes('第一步先复核'),
    'zh critical new-course prompt should require reviewing reminders first',
  );
  assert.ok(
    zhNewCoursePrompt.includes('在必要时整理接续包提醒项'),
    'zh critical new-course prompt should make reminder rewriting conditional when already clear',
  );
  assert.ok(
    zhNewCoursePrompt.includes('以清醒头脑删除冗余'),
    'zh critical new-course prompt should require clear-headed cleanup wording',
  );
  assert.ok(
    zhNewCoursePrompt.includes('直接继续推进原任务本身'),
    'zh critical new-course prompt should tell the agent to continue the underlying task',
  );

  const enNewCoursePrompt = formatNewCourseStartPrompt('en', {
    nextCourse: 3,
    source: 'critical_auto_clear',
  });
  assert.ok(
    enNewCoursePrompt.startsWith(formatSystemNoticePrefix('en')),
    'en critical new-course prompt should start with the system-notice prefix',
  );
  assert.ok(
    enNewCoursePrompt.includes('You are now in a new course'),
    'en critical new-course prompt should explicitly mark the new course boundary',
  );
  assert.ok(
    enNewCoursePrompt.includes('not a new user request'),
    'en critical new-course prompt should say it is not a new user request',
  );
  assert.ok(
    enNewCoursePrompt.includes('do not reply with a standalone "acknowledged/ok'),
    'en critical new-course prompt should forbid standalone acknowledgement replies',
  );
  assert.ok(
    enNewCoursePrompt.includes('your first step is to review'),
    'en critical new-course prompt should require reviewing reminders first',
  );
  assert.ok(
    enNewCoursePrompt.includes('if needed, rewrite any continuation-package reminders'),
    'en critical new-course prompt should make reminder rewriting conditional when already clear',
  );
  assert.ok(
    enNewCoursePrompt.includes('with a clear head'),
    'en critical new-course prompt should require clear-headed cleanup wording',
  );
  assert.ok(
    enNewCoursePrompt.includes('continue the underlying task itself directly'),
    'en critical new-course prompt should tell the agent to continue the underlying task',
  );

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
