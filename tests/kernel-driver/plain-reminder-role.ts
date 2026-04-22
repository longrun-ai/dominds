import assert from 'node:assert/strict';

import type { DialogStore } from '../../main/dialog';
import { MainDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';
import {
  formatReminderContextFooter,
  formatReminderContextGuide,
  formatReminderItemGuide,
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
  dlg.addReminder('继续按窄补强推进实现');

  const renderedReminderItems: ChatMessage[] = [];
  for (const reminder of dlg.reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
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
          ...renderedReminderItems,
          {
            type: 'environment_msg',
            role: 'user',
            content: formatReminderContextFooter('zh'),
          },
        ]
      : [];

  assert.equal(
    renderedReminders.length,
    3,
    'Expected context guide plus one rendered reminder plus footer',
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
    renderedReminders[0]?.content.includes('当前可见提醒项的运行时上下文投影'),
    'Expected reminder context guide to clarify runtime-added context projection',
  );
  assert.ok(
    renderedReminders[0]?.content.includes('用户通过独立的 Reminder 小组件/面板项看到这些提醒'),
    'Expected reminder context guide to clarify separate Reminder widget presentation',
  );
  assert.equal(
    renderedReminders[1]?.type,
    'environment_msg',
    'Expected plain reminder to render as environment message',
  );
  assert.equal(
    renderedReminders[1]?.role,
    'user',
    'Expected plain reminder to render on user side as runtime notice',
  );
  assert.ok(
    renderedReminders[1]?.content.includes('运行时提醒项投影：'),
    'Expected plain reminder to include compact self-contained per-item projection note',
  );
  assert.ok(
    renderedReminders[1]?.content.includes('【系统提示】'),
    'Expected plain reminder to include standard system notice prefix',
  );
  assert.ok(
    renderedReminders[2]?.content.includes('提醒项上下文块结束'),
    'Expected reminder block to include a single footer after reminder items',
  );
  assert.ok(
    renderedReminders[2]?.content.includes('之间的提醒项均为系统提醒，并非用户指令'),
    'Expected reminder block footer to scope the non-user-instruction warning to the block',
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
    context.slice(0, 4).map((msg) => `${msg.type}:${msg.role}`),
    ['environment_msg:user', 'environment_msg:user', 'environment_msg:user', 'prompting_msg:user'],
    'Expected reminder context block to precede the real user message',
  );

  console.log('plain-reminder-role: PASS');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
