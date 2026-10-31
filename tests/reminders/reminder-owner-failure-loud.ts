import assert from 'node:assert/strict';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder, type ReminderOwner } from '../../main/tool';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { recordDialogEvents } from '../helpers/dialog-events';
import { manualReminderSnapshot, withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-reminder-owner-');
async function main() {
  await withManualReminderDialog('en', async (dialog) => {
    const failure = new Error('owner update exploded');
    let fail = false;
    let updateCalls = 0;
    const owner: ReminderOwner = {
      name: 'reminder-owner-failure-loud',
      async updateReminder() {
        updateCalls++;
        if (fail) throw failure;
        return { treatment: 'keep' };
      },
      async renderReminder(_dialog, reminder) {
        return { type: 'transient_guide_msg', role: 'assistant', content: reminder.content };
      },
    };
    registerReminderOwner(owner);
    try {
      const reminder = dialog.addReminder(
        'Owner-managed stale reminder',
        owner,
        { state: 'unchanged' },
        undefined,
        { scope: 'dialog', renderMode: 'plain' },
      );
      await dialog.processReminderUpdates();
      assert.equal(updateCalls, 1);
      const before = await manualReminderSnapshot(dialog);
      const events = recordDialogEvents(dialog);
      fail = true;
      await assert.rejects(
        () => dialog.processReminderUpdates(),
        (error: unknown) => {
          assert.equal(error, failure); // Preserve the injected cause, not generated error prose.
          return true;
        },
      );
      assert.equal(updateCalls, 2);
      assert.deepEqual(await manualReminderSnapshot(dialog), before);
      const received = await events.finish();
      const errors = received.filter((event) => event.type === 'stream_error_evt');
      assert.equal(errors.length, 1);
      const errorEvent = errors[0]!;
      assert.equal(errorEvent.course, dialog.currentCourse);
      assert.equal(errorEvent.genseq, undefined);
      assert.equal(
        received.some((event) => event.type === 'full_reminders_update'),
        false,
      );
      evidence.record({
        id: 'owner-update-failure',
        scenario:
          'A registered owner throws on its second actual reconciliation. The original injected error propagates, exactly one actual stream-error event is emitted, no full successful snapshot is published and public memory/disk data remain unchanged.',
        businessValue:
          'Expose stale runtime-owned state and preserve work instead of silently treating a failed refresh as success.',
        context: {
          reminderId: reminder.id,
          owner: owner.name,
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          course: dialog.currentCourse,
          taskDocPath: dialog.taskDocPath,
          injectedFailure: failure.message,
          scope:
            'Real Dialog, owner callback, disk and event registry. This process does not run an LLM generation, browser, actual daemon or restart.',
        },
        reviewQuestions: [
          'Does the actual error event accurately locate the failing owner/reminder/dialog and avoid presenting the failed refresh as a successful or current state?',
        ],
        actualText: errorEvent.error,
      });
    } finally {
      unregisterReminderOwner(owner.name);
    }
  });
  await withManualReminderDialog('en', async (dialog) => {
    let phase = 0;
    let updates = 0;
    const owner: ReminderOwner = {
      name: 'reminder-owner-equal-meta-no-jitter',
      async updateReminder(_dialog, reminder) {
        updates++;
        return {
          treatment: 'update',
          updatedContent: phase === 2 ? 'Changed owner data' : reminder.content,
          updatedMeta: {
            nested: { b: 2, a: 1 },
            state: 'same',
            sequence: phase === 0 ? [1, 2] : [2, 1],
          },
        };
      },
      async renderReminder(_dialog, reminder) {
        return { type: 'transient_guide_msg', role: 'assistant', content: reminder.content };
      },
    };
    registerReminderOwner(owner);
    try {
      const stable = materializeReminder({
        id: 'ownerstable001',
        createdAt: '2001-01-01 00:00:00',
        priority: 'medium',
        content: 'Stable owner-managed reminder',
        owner,
        meta: { state: 'same', nested: { a: 1, b: 2 }, sequence: [1, 2] },
        scope: 'dialog',
        renderMode: 'plain',
      });
      dialog.reminders.push(stable);
      dialog.touchReminders();
      const version = dialog.remindersVer;
      const updatedAt = dialog.updatedAt;
      const first = await dialog.processReminderUpdates();
      assert.equal(updates, 1);
      assert.equal(dialog.remindersVer, version);
      assert.equal(dialog.updatedAt, updatedAt);
      const firstView = first.find((row) => row.reminder_id === stable.id);
      assert.ok(firstView);
      const before = await manualReminderSnapshot(dialog);
      const second = await dialog.processReminderUpdates();
      assert.equal(updates, 2);
      assert.equal(dialog.remindersVer, version);
      assert.equal(dialog.updatedAt, updatedAt);
      assert.deepEqual(await manualReminderSnapshot(dialog), before);
      assert.deepEqual(second, first);
      phase = 1;
      const third = await dialog.processReminderUpdates();
      assert.equal(updates, 3);
      assert.equal(dialog.remindersVer, version + 1);
      const arrayChangedView = third.find((row) => row.reminder_id === stable.id);
      assert.ok(arrayChangedView);
      assert.equal(arrayChangedView.content, stable.content);
      assert.notEqual(arrayChangedView.renderRevision, firstView.renderRevision);
      assert.deepEqual(arrayChangedView.meta, {
        state: 'same',
        nested: { a: 1, b: 2 },
        sequence: [2, 1],
      });
      const arrayStored = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
      assert.deepEqual(
        arrayStored.find((row) => row.id === stable.id)?.meta,
        arrayChangedView.meta,
      );
      phase = 2;
      const fourth = await dialog.processReminderUpdates();
      assert.equal(updates, 4);
      assert.equal(dialog.remindersVer, version + 2);
      const changedView = fourth.find((row) => row.reminder_id === stable.id);
      assert.ok(changedView);
      assert.equal(changedView.content, 'Changed owner data');
      assert.equal(changedView.renderMode, 'plain');
      assert.notEqual(changedView.renderRevision, arrayChangedView.renderRevision);
      const stored = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
      assert.equal(stored.find((row) => row.id === stable.id)?.content, 'Changed owner data');
    } finally {
      unregisterReminderOwner(owner.name);
    }
  });
  await evidence.write();
  console.log('Owner failure propagation/events and equivalent metadata stability: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Reminder owner case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
