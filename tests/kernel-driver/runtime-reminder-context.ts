import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { setMainDialogGoalReminder } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-runtime-reminder-context-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const apiType = 'test-reminder-context';
      await writeStandardMinds(rtws, { providerApiType: apiType });
      const captured: ChatMessage[][] = [];
      const generator: LlmGenerator = {
        apiType,
        async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver) {
          captured.push(structuredClone(context));
          await receiver.funcCall(
            `context-answer-${captured.length}`,
            'answerHuman',
            JSON.stringify({ answerContent: `answer-data-${captured.length}` }),
          );
          return {
            usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
            llmGenModel: 'default',
          };
        },
        async genMoreMessages() {
          throw new Error('streaming fixture only');
        },
      };
      registerLlmGenerator(generator);
      try {
        const taskDocPath = 'reminder-fixture.tsk';
        await fs.mkdir(path.join(rtws, taskDocPath), { recursive: true });
        for (const [file, content] of Object.entries({
          'goals.md': 'Verify reminder delivery while answering the current human turn.\n',
          'constraints.md': 'Use the supplied reminder and user data.\n',
          'progress.md': 'Two isolated user turns are ready to execute.\n',
        }))
          await fs.writeFile(path.join(rtws, taskDocPath, file), content);
        const root = await createMainDialog('tester', taskDocPath);
        const goal = 'Verify reminder delivery while answering the current human turn.';
        assert.equal(
          (await setMainDialogGoalReminder(root, { mode: 'goal', goal })).kind,
          'updated',
        );
        root.disableDiligencePush = true;
        const reminder = root.addReminder('reminder-data-A-17ca', undefined, undefined, undefined, {
          scope: 'dialog',
          renderMode: 'markdown',
        });
        await driveDialogStream(root, makeUserPrompt('user-data-1-723d', 'context-user-1'), true);
        await waitForAllDialogsUnlocked(root, 3_000);
        root.addReminder('reminder-data-B-28ef', undefined, undefined, undefined, {
          scope: 'dialog',
          renderMode: 'markdown',
        });
        await driveDialogStream(root, makeUserPrompt('user-data-2-835e', 'context-user-2'), true);
        await waitForAllDialogsUnlocked(root, 3_000);
        assert.equal(captured.length, 2);
        for (const [index, context] of captured.entries()) {
          const latestUserIndex = context.findIndex(
            (message) =>
              message.type === 'prompting_msg' && message.msgId === `context-user-${index + 1}`,
          );
          assert.equal(
            latestUserIndex,
            context.length - 1,
            'the actual current user input follows runtime context',
          );
          const projected = context.filter(
            (message) => 'content' in message && message.content.includes('reminder-data-A-17ca'),
          );
          assert.equal(projected.length, 1);
          assert.equal(projected[0].type, 'environment_msg');
          assert.equal(projected[0].role, 'user');
          const reminderIndex = context.indexOf(projected[0]);
          assert.ok(reminderIndex < latestUserIndex);
          assert.ok(
            context.some(
              (message, at) =>
                message.type === 'transient_guide_msg' &&
                message.role === 'assistant' &&
                message.content.includes(reminder.id) &&
                at < reminderIndex,
            ),
            'maintenance identities are delivered as assistant guidance before reminder content',
          );
          if (index === 1) {
            const historicalUser = context.findIndex(
              (message) => message.type === 'prompting_msg' && message.msgId === 'context-user-1',
            );
            assert.ok(historicalUser >= 0 && historicalUser < reminderIndex);
            assert.ok(
              context.some(
                (message, at) =>
                  message.type === 'environment_msg' &&
                  message.content.includes('reminder-data-B-28ef') &&
                  at < latestUserIndex,
              ),
            );
          }
        }
        const answers = await DialogPersistence.loadAnswersToHumanState(root.id, root.status);
        assert.deepEqual(
          answers.map((answer) => answer.content),
          ['answer-data-1', 'answer-data-2'],
        );
        evidence.record({
          id: `runtime-context-${language}`,
          scenario:
            'Two real user turns run with one reminder and then a newly added second reminder; the provider records the actual assembled context.',
          businessValue:
            'Keep reminder projections and maintenance guidance separate from historical work and current human intent.',
          context: {
            language,
            mainDialogGoal: goal,
            taskDocPath,
            reminderId: reminder.id,
            initialReminderPayload: 'reminder-data-A-17ca',
            addedReminderPayload: 'reminder-data-B-28ef',
            latestUserId: 'context-user-2',
          },
          reviewQuestions: [
            'Do the actual messages distinguish runtime reminders from new human requests, while preserving the real latest user input?',
            'Are maintenance identities and the footer understandable without telling the model to treat later human input as a reminder or claim to have answered the human already?',
          ],
          actualText: JSON.stringify(captured[1], null, 2),
        });
      } finally {
        unregisterLlmGenerator(apiType);
      }
    }
  });
  await evidence.write();
  console.log('runtime reminder context behavior: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
