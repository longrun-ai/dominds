import assert from 'node:assert/strict';

import type { DialogStore } from '../../main/dialog';
import { RootDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';
import { formatReminderItemGuide } from '../../main/runtime/driver-messages';
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

  const renderedReminders: ChatMessage[] = [];
  for (const reminder of dlg.reminders) {
    if (!reminder || !reminderEchoBackEnabled(reminder)) {
      continue;
    }
    renderedReminders.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: formatReminderItemGuide('zh', reminder.id, reminder.content, {
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
    },
  });

  assert.deepEqual(
    context.slice(0, 2).map((msg) => `${msg.type}:${msg.role}`),
    ['prompting_msg:user', 'transient_guide_msg:assistant'],
    'Expected plain reminders to stay on assistant side in assembled context',
  );

  console.log('plain-reminder-role: PASS');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
