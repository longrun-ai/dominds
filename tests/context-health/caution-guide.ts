/**
 * v3 remediation (caution) guide formatting regression
 *
 * This test focuses on copy stability and non-throw behavior for both:
 * - soft (grace period) guide
 * - hard (curate reminders) guide
 */

import assert from 'node:assert/strict';
import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatSystemNoticePrefix,
} from '../../main/runtime/driver-messages';

async function main(): Promise<void> {
  const zhSoft = formatAgentFacingContextHealthV3RemediationGuide('zh', {
    kind: 'caution',
    mode: 'soft',
    dialogScope: 'mainDialog',
  });
  assert.ok(
    zhSoft.startsWith(formatSystemNoticePrefix('zh')),
    'zh guide should start with the system-notice prefix',
  );
  assert.ok(zhSoft.includes('上下文状态：🟡 吃紧'), 'zh guide should include caution headline');
  assert.ok(zhSoft.includes('clear_mind'), 'zh guide should mention clear_mind');
  assert.ok(zhSoft.includes('update_reminder'), 'zh guide should mention update_reminder');
  assert.ok(zhSoft.includes('add_reminder'), 'zh guide should mention add_reminder');
  assert.ok(zhSoft.includes('do_mind'), 'zh guide should mention do_mind for Taskdoc creation');
  assert.ok(
    zhSoft.includes('change_mind'),
    'zh guide should mention change_mind for Taskdoc updates',
  );
  assert.ok(
    !zhSoft.includes('mind_more'),
    'zh remediation guide should not recommend mind_more for preserving discussion details',
  );
  assert.ok(
    zhSoft.includes('不是新的用户诉求'),
    'zh guide should say it is not a new user request',
  );
  assert.ok(
    zhSoft.includes('不要只回复“收到/好的/我先整理提醒项”'),
    'zh guide should forbid standalone acknowledgement replies',
  );
  assert.ok(
    zhSoft.includes('多条粗略提醒项'),
    'zh guide should allow rough multi-reminder bridge when muddled',
  );
  assert.ok(
    zhSoft.includes('尚未落实到文档、且下一程需要知会的讨论细节'),
    'zh guide should require documenting unrecorded discussion details before bridge reminders',
  );
  assert.ok(
    !zhSoft.includes('头脑还清楚'),
    'zh guide should avoid subjective self-assessment wording',
  );
  assert.ok(
    zhSoft.includes('优先新增过桥提醒项'),
    'zh guide should prefer add_reminder as the first remediation move',
  );
  assert.ok(
    !zhSoft.includes('reminder_no": 1'),
    'zh guide should not hardcode reminder #1 as the recommended target',
  );
  assert.ok(
    zhSoft.includes('允许先带着一定冗余'),
    'zh guide should allow temporary redundancy during the current course',
  );
  assert.ok(
    zhSoft.includes('真正清理冗余、合并提醒项，放到新一程再做'),
    'zh guide should defer reminder cleanup to the next course',
  );
  assert.ok(
    !zhSoft.includes('支线对话'),
    'zh main guide should not ask the agent to reason about side-dialog handling',
  );

  const enSoft = formatAgentFacingContextHealthV3RemediationGuide('en', {
    kind: 'caution',
    mode: 'soft',
    dialogScope: 'mainDialog',
  });
  assert.ok(
    enSoft.startsWith(formatSystemNoticePrefix('en')),
    'en guide should start with the system-notice prefix',
  );
  assert.ok(enSoft.includes('Context state: 🟡 caution'), 'en guide should include caution');
  assert.ok(enSoft.includes('update_reminder'), 'en guide should mention update_reminder');
  assert.ok(enSoft.includes('add_reminder'), 'en guide should mention add_reminder');
  assert.ok(enSoft.includes('do_mind'), 'en guide should mention do_mind for Taskdoc creation');
  assert.ok(
    enSoft.includes('change_mind'),
    'en guide should mention change_mind for Taskdoc updates',
  );
  assert.ok(
    !enSoft.includes('mind_more'),
    'en remediation guide should not recommend mind_more for preserving discussion details',
  );
  assert.ok(enSoft.includes('clear_mind'), 'en guide should mention clear_mind');
  assert.ok(
    enSoft.includes('not a new user request'),
    'en guide should say it is not a new user request',
  );
  assert.ok(
    enSoft.includes('do not reply with a standalone "acknowledged/ok'),
    'en guide should forbid standalone acknowledgement replies',
  );
  assert.ok(
    enSoft.includes('rough multi-reminder carry-over is acceptable'),
    'en guide should allow rough multi-reminder bridge during remediation',
  );
  assert.ok(
    enSoft.includes(
      'discussion details that are not yet documented but the next course needs to know',
    ),
    'en guide should require documenting unrecorded discussion details before bridge reminders',
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
  assert.ok(
    enSoft.includes('Prefer adding a bridge reminder first'),
    'en guide should prefer add_reminder as the first remediation move',
  );
  assert.ok(
    !enSoft.includes('reminder_no": 1'),
    'en guide should not hardcode reminder #1 as the recommended target',
  );
  assert.ok(
    enSoft.includes('Some redundancy is acceptable'),
    'en guide should allow temporary redundancy during the current course',
  );
  assert.ok(
    enSoft.includes('reminder cleanup and dedup belong to the new course'),
    'en guide should defer reminder cleanup to the new course',
  );
  assert.ok(
    !enSoft.includes('Side Dialog'),
    'en main guide should not ask the agent to reason about side-dialog handling',
  );

  const zhSide = formatAgentFacingContextHealthV3RemediationGuide('zh', {
    kind: 'caution',
    mode: 'soft',
    dialogScope: 'sideDialog',
  });
  assert.ok(
    zhSide.includes('你当前处于支线对话'),
    'zh side guide should be explicit about side-dialog scope',
  );
  assert.ok(
    zhSide.includes('不要维护差遣牒，也不要整理差遣牒更新提案'),
    'zh side guide should not ask the agent to decide or draft Taskdoc updates',
  );
  assert.ok(
    zhSide.includes('提醒项长度没有技术限制'),
    'zh side guide should permit detailed reminders without technical length pressure',
  );
  assert.ok(!zhSide.includes('do_mind'), 'zh side guide should not mention do_mind');
  assert.ok(!zhSide.includes('mind_more'), 'zh side guide should not mention mind_more');
  assert.ok(!zhSide.includes('change_mind'), 'zh side guide should not mention change_mind');

  const enSide = formatAgentFacingContextHealthV3RemediationGuide('en', {
    kind: 'caution',
    mode: 'soft',
    dialogScope: 'sideDialog',
  });
  assert.ok(
    enSide.includes('you are in a Side Dialog'),
    'en side guide should be explicit about side-dialog scope',
  );
  assert.ok(
    enSide.includes(
      'Do not maintain Taskdoc in this course, and do not draft Taskdoc update proposals',
    ),
    'en side guide should not ask the agent to decide or draft Taskdoc updates',
  );
  assert.ok(
    enSide.includes('Reminder length has no technical limit'),
    'en side guide should permit detailed reminders without technical length pressure',
  );
  assert.ok(!enSide.includes('do_mind'), 'en side guide should not mention do_mind');
  assert.ok(!enSide.includes('mind_more'), 'en side guide should not mention mind_more');
  assert.ok(!enSide.includes('change_mind'), 'en side guide should not mention change_mind');

  console.log('OK');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
