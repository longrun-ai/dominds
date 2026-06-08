import assert from 'node:assert/strict';

import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';
import {
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
  formatReminderMaintenanceReference,
} from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { reminderEchoBackEnabled } from '../../main/tool';

async function main(): Promise<void> {
  setWorkLanguage('zh');

  const dlg = new MainDialog(
    {} as unknown as DialogStore,
    'plain-reminder-role.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('继续按窄补强推进实现', undefined, undefined, undefined, {
    scope: 'dialog',
    renderMode: 'markdown',
  });

  const renderedReminderItems: ChatMessage[] = [];
  const maintenanceReferenceItems: Array<{ id: string; meta?: unknown }> = [];
  for (const reminder of dlg.reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    maintenanceReferenceItems.push({ id: reminder.id, meta: reminder.meta });
    renderedReminderItems.push({
      type: 'environment_msg',
      role: 'user',
      content: formatReminderItemGuide('zh', reminder.id, reminder.content, {
        meta: reminder.meta,
      }),
    });
  }
  const renderedReminders: ChatMessage[] =
    renderedReminderItems.length > 0
      ? [
          {
            type: 'environment_msg',
            role: 'user',
            content: formatReminderContextGuide('zh'),
          },
          {
            type: 'transient_guide_msg',
            role: 'assistant',
            content: formatReminderMaintenanceReference('zh', maintenanceReferenceItems) ?? '',
          },
          ...renderedReminderItems,
          {
            type: 'environment_msg',
            role: 'user',
            content: formatReminderContextFooter('zh', {
              dialogScope: { kind: 'main_dialog' },
              followingMessage: { kind: 'user_message' },
              business: { kind: 'none' },
              contextHealth: { kind: 'normal' },
            }),
          },
        ]
      : [];

  assert.equal(
    renderedReminders.length,
    4,
    'Expected context guide plus maintenance reference plus one rendered reminder plus footer',
  );
  assert.equal(
    renderedReminders[0]?.type,
    'environment_msg',
    'Expected reminder context guide to render as environment message',
  );
  assert.equal(
    renderedReminders[0]?.role,
    'user',
    'Expected reminder context guide to render on user side as runtime context',
  );
  assert.ok(
    renderedReminders[0]?.content.includes('Dominds 为你放到当前上下文里的可见提醒项'),
    'Expected reminder context guide to clarify Dominds-added reminder context',
  );
  assert.ok(
    renderedReminders[0]?.content.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected reminder context guide to clarify separate Reminder widget presentation',
  );
  assert.equal(
    renderedReminders[1]?.type,
    'transient_guide_msg',
    'Expected reminder maintenance reference to render as assistant-side guide',
  );
  assert.equal(
    renderedReminders[1]?.role,
    'assistant',
    'Expected reminder maintenance reference to use assistant role',
  );
  assert.ok(
    renderedReminders[1]?.content.includes('reminder_id='),
    'Expected reminder maintenance reference to identify reminder ids',
  );
  assert.equal(
    renderedReminders[2]?.type,
    'environment_msg',
    'Expected plain reminder to render as environment message',
  );
  assert.equal(
    renderedReminders[2]?.role,
    'user',
    'Expected plain reminder to render on user side as runtime notice',
  );
  assert.ok(
    renderedReminders[2]?.content.includes('Dominds 提醒项说明：'),
    'Expected plain reminder to include compact self-contained per-item projection note',
  );
  assert.ok(
    renderedReminders[2]?.content.includes('【系统提示】'),
    'Expected plain reminder to include standard system notice prefix',
  );
  assert.ok(
    renderedReminders[3]?.content.includes('提醒项上下文块结束'),
    'Expected reminder block to include a single footer after reminder items',
  );
  assert.ok(
    renderedReminders[3]?.content.includes('之间的提醒项均为系统提醒，并非用户诉求/指令'),
    'Expected reminder block footer to scope the non-user-request/instruction warning to the block',
  );
  assert.ok(
    renderedReminders[3]?.content.includes('后续消息是用户的新诉求/指令，不是提醒项投影'),
    'Expected reminder block footer to explicitly preserve the following real user message as a user request/instruction',
  );

  const context = assembleDriveContextMessages({
    base: {
      prependedContextMessages: [],
      memories: [],
      taskDocMsg: undefined,
      coursePrefixMsgs: [],
      historicalDialogMsgsForContext: [],
      currentTurnDialogMsgsForContext: [
        {
          type: 'prompting_msg',
          role: 'user',
          genseq: 1,
          msgId: 'u1',
          grammar: 'markdown',
          content: '用户问题',
        },
      ],
    },
    tail: {
      renderedReminders,
      activeReplyObligationContext: [],
      runtimeGuideMsgs: [],
    },
  });

  assert.deepEqual(
    context.slice(0, 5).map((msg) => `${msg.type}:${msg.role}`),
    [
      'environment_msg:user',
      'transient_guide_msg:assistant',
      'environment_msg:user',
      'environment_msg:user',
      'prompting_msg:user',
    ],
    'Expected reminder context block to precede the real user message',
  );
  assert.equal(
    context[4]?.type === 'prompting_msg' ? context[4].content : undefined,
    '用户问题',
    'Expected the real user message to remain a prompting message immediately after the reminder block',
  );

  console.log('plain-reminder-role: PASS');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
