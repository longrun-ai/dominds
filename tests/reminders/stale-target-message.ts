import assert from 'node:assert/strict';
import type { MainDialog } from '../../main/dialog';
import { materializeReminder } from '../../main/tool';
import { deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import {
  manualReminderSnapshot,
  reminderCaller,
  withManualReminderDialog,
} from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-reminder-stale-');
// Control exactly the interleaving after the real resolver takes a target. The target
// and its old index come from the actual visible collection, rather than a fake index.
async function afterResolution<T>(
  dialog: MainDialog,
  mutate: () => Promise<void>,
  action: () => Promise<T>,
) {
  const original = dialog.resolveReminderTargetById;
  let resolutions = 0;
  dialog.resolveReminderTargetById = async function (id) {
    const target = await original.call(this, id);
    assert.ok(target);
    assert.equal(target.source, 'dialog');
    resolutions++;
    await mutate();
    return target;
  };
  try {
    const result = await action();
    assert.equal(resolutions, 1);
    return result;
  } finally {
    dialog.resolveReminderTargetById = original;
  }
}
async function main() {
  for (const language of ['zh', 'en'] as const) {
    for (const tool of [deleteReminderTool, updateReminderTool]) {
      for (const disappeared of [true, false]) {
        await withManualReminderDialog(language, async (dialog) => {
          // Supply complete historical fields, so read-back equality does not
          // confuse persistence defaults with effects of the mutation.
          const target = materializeReminder({
            id: 'stable-target',
            content: 'original target data',
            scope: 'dialog',
            renderMode: 'plain',
            createdAt: '2001-01-01 00:00:00',
            priority: 'medium',
          });
          const decoy = materializeReminder({
            id: 'unrelated-target',
            content: 'unrelated work data',
            meta: { retained: true },
            scope: 'dialog',
            renderMode: 'markdown',
            createdAt: '2001-01-01 00:00:00',
            priority: 'medium',
          });
          const preceding = materializeReminder({
            id: 'preceding-target',
            content: 'other actor removes this to shift the target',
            scope: 'dialog',
            renderMode: 'markdown',
            createdAt: '2001-01-01 00:00:00',
            priority: 'medium',
          });
          dialog.reminders.push(preceding, target, decoy);
          await dialog.processReminderUpdates();
          const decoyBefore = (await manualReminderSnapshot(dialog)).memory.find(
            (row) => row.id === decoy.id,
          );
          let beforeMutation: Awaited<ReturnType<typeof manualReminderSnapshot>> | undefined;
          const input = {
            reminder_id: target.id,
            ...(tool === updateReminderTool ? { content: 'replacement target data' } : {}),
          };
          const output = await afterResolution(
            dialog,
            async () => {
              const index = dialog.reminders.findIndex((row) => row.id === target.id);
              assert.ok(index >= 0);
              const precedingIndex = dialog.reminders.findIndex((row) => row.id === preceding.id);
              assert.ok(precedingIndex >= 0);
              dialog.deleteReminder(disappeared ? index : precedingIndex);
              beforeMutation = await manualReminderSnapshot(dialog);
            },
            async () => {
              return tool.call(dialog, reminderCaller, input);
            },
          );
          assert.ok(beforeMutation);
          assert.equal(output.outcome, disappeared ? 'failure' : 'success');
          const current = await manualReminderSnapshot(dialog);
          assert.deepEqual(current.disk, beforeMutation.disk);
          assert.equal(current.remindersVer, beforeMutation.remindersVer + (disappeared ? 0 : 1));
          if (disappeared) assert.equal(current.updatedAt, beforeMutation.updatedAt);
          assert.deepEqual(
            current.memory.find((row) => row.id === decoy.id),
            decoyBefore,
          );
          const expectedMemory = beforeMutation.memory.flatMap((row) => {
            if (row.id !== target.id) return [row];
            if (tool === deleteReminderTool) return [];
            return [{ ...row, content: 'replacement target data' }];
          });
          assert.deepEqual(current.memory, expectedMemory);
          const remaining = current.memory.find((row) => row.id === target.id);
          if (disappeared || tool === deleteReminderTool) assert.equal(remaining, undefined);
          else {
            assert.ok(remaining);
            assert.equal(remaining.content, 'replacement target data');
            assert.equal(remaining.renderMode, 'plain');
          }
          await dialog.processReminderUpdates();
          const persisted = await manualReminderSnapshot(dialog);
          assert.deepEqual(persisted.disk, persisted.memory);
          evidence.record({
            id: `${language}-${tool.name}-${disappeared ? 'removed' : 'moved'}`,
            scenario: disappeared
              ? 'A real target disappears after actual ID resolution and before manual mutation; refuse safely while preserving unrelated work.'
              : 'A real target shifts after actual ID resolution; the old index now belongs to unrelated work, but the tool must mutate only the requested stable ID.',
            businessValue:
              'Preserve intended reminder identity when its visible list changes during an awaited operation.',
            context: {
              language,
              tool: tool.name,
              input: JSON.stringify(input),
              reminderId: target.id,
              unrelatedId: decoy.id,
              scope:
                'Controlled in-process post-resolution interleaving through real resolver, public deleteReminder and handler; actual disk after reconciliation. No multicore/thread/restart claim.',
            },
            reviewQuestions: [
              'Does the actual receipt accurately distinguish a removed target from a successful mutation by ID, and explain a useful next step without exposing positional implementation detail?',
            ],
            actualText: output.content,
          });
        });
      }
    }
    await withManualReminderDialog(language, async (dialog) => {
      const id = 'duplicate-reminder-id';
      for (const content of ['first duplicate reminder', 'second duplicate reminder'])
        dialog.reminders.push(
          materializeReminder({ id, content, scope: 'dialog', renderMode: 'markdown' }),
        );
      const before = await manualReminderSnapshot(dialog);
      let caught: Error | undefined;
      try {
        await deleteReminderTool.call(dialog, reminderCaller, { reminder_id: id });
      } catch (error: unknown) {
        assert.ok(error instanceof Error);
        caught = error;
      }
      assert.ok(caught);
      assert.deepEqual(await manualReminderSnapshot(dialog), before);
      evidence.record({
        id: language + '-duplicate-identity',
        scenario:
          'Corrupt imported local data contains two identical reminder IDs; deletion must throw before choosing either work note.',
        businessValue:
          'Expose ambiguous persisted identity without silently deleting the wrong reminder.',
        context: {
          language,
          duplicateId: id,
          copies: 2,
          scope:
            'Deliberately seeded corrupt data; actual resolver and handler. No corruption of an on-disk file or startup repair is claimed.',
        },
        reviewQuestions: [
          'Does the actual error identify the ambiguous duplicate identity accurately without implying a successful delete?',
        ],
        actualText: caught.message,
      });
    });
  }
  await evidence.write();
  console.log('Actual reminder resolution interleavings and duplicate-ID refusal: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Reminder interleaving case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
