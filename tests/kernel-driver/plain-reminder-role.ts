import assert from 'node:assert/strict';

import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';
import { formatReminderItemGuide } from '../../main/shared/i18n/driver-messages';
import { setWorkLanguage } from '../../main/shared/runtime-language';
import { computeReminderNoByIndex, reminderEchoBackEnabled } from '../../main/tool';

async function main(): Promise<void> {
  setWorkLanguage('zh');

  const dlg = new RootDialog(
    {} as unknown as DialogStore,
    'plain-reminder-role.tsk',
    undefined,
    'tester',
  );
  dlg.addReminder('继续按窄补强推进实现');

  const reminderNoByIndex = computeReminderNoByIndex(dlg.reminders);
  const renderedReminders: ChatMessage[] = [];
  for (let index = 0; index < dlg.reminders.length; index += 1) {
    const reminder = dlg.reminders[index];
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    const reminderNo = reminderNoByIndex.get(index);
    if (reminderNo === undefined) {
      continue;
    }
    renderedReminders.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: formatReminderItemGuide('zh', reminderNo, reminder.content, {
        meta: reminder.meta,
      }),
    });
  }

  assert.equal(renderedReminders.length, 1, 'Expected one rendered reminder');
  assert.equal(
    renderedReminders[0]?.type,
    'transient_guide_msg',
    'Expected plain reminder to render as transient guide',
  );
  assert.equal(
    renderedReminders[0]?.role,
    'assistant',
    'Expected plain reminder to render as assistant-authored self note',
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
      languageGuideMsg: {
        type: 'environment_msg',
        role: 'user',
        content: 'language-guide',
      },
    },
  });

  assert.deepEqual(
    context.map((msg) => `${msg.type}:${msg.role}`),
    ['prompting_msg:user', 'transient_guide_msg:assistant', 'environment_msg:user'],
    'Expected plain reminders to stay on assistant side even when paired with user-side system guides',
  );

  console.log('plain-reminder-role: PASS');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
