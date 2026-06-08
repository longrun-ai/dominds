import assert from 'node:assert/strict';

import { DialogStore, MainDialog, type Dialog } from '../../main/dialog';
import { materializeReminder, type ReminderOwner } from '../../main/tool';

class CapturingDialogStore extends DialogStore {
  public readonly streamErrors: string[] = [];

  public override async streamError(_dialog: Dialog, error: string): Promise<void> {
    this.streamErrors.push(error);
  }
}

async function main(): Promise<void> {
  const store = new CapturingDialogStore();
  const dialog = new MainDialog(store, 'reminder-owner-failure-loud.tsk', undefined, 'tester');
  const failure = new Error('owner update exploded');
  const failingOwner: ReminderOwner = {
    name: 'reminder-owner-failure-loud',
    async updateReminder() {
      throw failure;
    },
    async renderReminder(_dlg, reminder) {
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: reminder.content,
      };
    },
  };

  dialog.reminders.push(
    materializeReminder({
      id: 'ownerfail001',
      content: 'Owner-managed stale reminder',
      owner: failingOwner,
      scope: 'dialog',
      renderMode: 'markdown',
    }),
  );

  await assert.rejects(() => dialog.processReminderUpdates(), failure);
  assert.equal(store.streamErrors.length, 1, 'Expected owner failure to emit stream_error_evt');
  assert.match(store.streamErrors[0] ?? '', /Reminder owner update failed/);
  assert.match(store.streamErrors[0] ?? '', /reminderId=ownerfail001/);

  const stableDialog = new MainDialog(
    new DialogStore(),
    'reminder-owner-equal-meta-no-jitter.tsk',
    undefined,
    'tester',
  );
  const stableOwner: ReminderOwner = {
    name: 'reminder-owner-equal-meta-no-jitter',
    async updateReminder(_dlg, reminder) {
      return {
        treatment: 'update',
        updatedContent: reminder.content,
        updatedMeta: { state: 'same' },
      };
    },
    async renderReminder(_dlg, reminder) {
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: reminder.content,
      };
    },
  };
  stableDialog.reminders.push(
    materializeReminder({
      id: 'ownerstable001',
      content: 'Stable owner-managed reminder',
      owner: stableOwner,
      meta: { state: 'same' },
      scope: 'dialog',
      renderMode: 'markdown',
    }),
  );
  const beforeUpdatedAt = stableDialog.updatedAt;
  await stableDialog.processReminderUpdates();
  assert.equal(
    stableDialog.updatedAt,
    beforeUpdatedAt,
    'Equivalent owner-updated reminder meta must not touch dialog updatedAt',
  );
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
