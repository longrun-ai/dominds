import assert from 'node:assert/strict';

import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { messageProvider } from '../helpers/message-provider';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-reminder-followup';
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const streaming of [true, false]) {
        await writeStandardMinds(rtws, { providerApiType: apiType, streaming });
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        const id = `reminder-${language}-${streaming ? 'stream' : 'batch'}`;
        const original = `initial-reminder-data-${id}`;
        const updated = `updated-reminder-data-${id}`;
        const reminder = root.addReminder(original, undefined, undefined, undefined, {
          scope: 'dialog',
          renderMode: 'markdown',
        });
        let requests = 0;
        const provider = messageProvider(
          apiType,
          ({ request, context, genseq, streaming: actualStreaming }) => {
            assert.equal(request.dialogSelfId, root.id.selfId);
            assert.equal(actualStreaming, streaming);
            requests += 1;
            assert.ok(requests <= 2);
            const body = requests === 1 ? original : updated;
            assert.ok(
              context.some((message) => 'content' in message && message.content.includes(body)),
              'the actual provider context contains the current opaque reminder body',
            );
            if (requests === 1)
              return {
                messages: [
                  {
                    type: 'func_call_msg',
                    role: 'assistant',
                    genseq,
                    id,
                    name: 'update_reminder',
                    arguments: JSON.stringify({ reminder_id: reminder.id, content: updated }),
                  },
                ],
                usage: { kind: 'unavailable' },
              };
            const results = context
              .filter((message) => message.type === 'func_result_msg')
              .filter((message) => message.id === id);
            assert.equal(results.length, 1);
            assert.equal(results[0].name, 'update_reminder');
            assert.equal(root.reminders.find((item) => item.id === reminder.id)?.content, updated);
            return {
              messages: [
                {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq,
                  content: `reminder-consumed-data-${id}`,
                },
              ],
              usage: { kind: 'unavailable' },
            };
          },
        );
        registerLlmGenerator(provider);
        try {
          await driveDialogStream(root, makeUserPrompt(`reminder-input-data-${id}`, id), true);
          await waitForAllDialogsUnlocked(root, 3000);
          provider.assertNoErrors();
          assert.equal(requests, 2);
          const events = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
          assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 2);
          assert.equal(
            events.filter((event) => event.type === 'func_result_record' && event.id === id).length,
            1,
          );
          assert.equal(
            events.filter(
              (event) =>
                event.type === 'agent_words_record' &&
                event.content === `reminder-consumed-data-${id}`,
            ).length,
            1,
          );
          const restored = await DialogPersistence.restoreDialog(root.id, root.status);
          assert.ok(restored);
          const durable = restored.reminders.filter((item) => item.id === reminder.id);
          assert.equal(durable.length, 1);
          assert.equal(durable[0].content, updated);
          assert.equal(durable[0].scope, 'dialog');
          assert.equal(durable[0].renderMode, 'markdown');
          assert.equal(
            hasPendingNextStepTriggers(
              await DialogPersistence.loadDialogLatest(root.id, root.status),
            ),
            false,
          );
        } finally {
          unregisterLlmGenerator(apiType);
        }
      }
    }
  });
  console.log('reminder mutation is durable and resumes once with the current body: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
