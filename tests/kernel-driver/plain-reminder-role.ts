import assert from 'node:assert/strict';

import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';
import {
  formatReminderContextGuide,
  formatReminderItemGuide,
} from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { reminderEchoBackEnabled } from '../../main/tool';

async function main(): Promise<void> {
  setWorkLanguage('zh');

  const dlg = new RootDialog(
    {} as unknown as DialogStore,
    'plain-reminder-role.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('继续按窄补强推进实现');

  const renderedReminderItems: ChatMessage[] = [];
  for (const reminder of dlg.reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    renderedReminderItems.push({
      type: 'transient_guide_msg',
      role: 'assistant',
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
          ...renderedReminderItems,
        ]
      : [];

  assert.equal(renderedReminders.length, 2, 'Expected context guide plus one rendered reminder');
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
    renderedReminders[0]?.content.includes('当前可见提醒项的运行时上下文投影'),
    'Expected reminder context guide to clarify runtime-added context projection',
  );
  assert.ok(
    renderedReminders[0]?.content.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected reminder context guide to clarify separate Reminder widget presentation',
  );
  assert.equal(
    renderedReminders[1]?.type,
    'transient_guide_msg',
    'Expected plain reminder to render as transient guide',
  );
  assert.equal(
    renderedReminders[1]?.role,
    'assistant',
    'Expected plain reminder to render as assistant-authored self note',
  );
  assert.ok(
    renderedReminders[1]?.content.includes('Reminder 上下文投影条目：'),
    'Expected plain assistant-side reminder to include compact self-contained per-item projection note',
  );

  const context = assembleDriveContextMessages({
    base: {
      prependedContextMessages: [],
      memories: [],
      taskDocMsg: undefined,
      coursePrefixMsgs: [],
      dialogMsgsForContext: [
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
    ephemeral: {},
    tail: {
      renderedReminders,
    },
  });

  assert.deepEqual(
    context.slice(0, 3).map((msg) => `${msg.type}:${msg.role}`),
    ['prompting_msg:user', 'environment_msg:user', 'transient_guide_msg:assistant'],
    'Expected reminder context guide to precede assistant-side plain reminder',
  );

  console.log('plain-reminder-role: PASS');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
