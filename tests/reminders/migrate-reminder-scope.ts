import assert from 'node:assert/strict';
import type { Dialog, MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { mutateSharedReminders } from '../../main/shared-reminders';
import { materializeReminder } from '../../main/tool';
import { addReminderTool, migrateReminderTool } from '../../main/tools/ctrl';
import { reminderData } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  captureSharedNotices,
  sharedReminderFile,
  withSharedReminderFixture,
} from '../helpers/shared-reminders';

const evidence = semanticEvidenceCollector('dominds-shared-migration-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withSharedReminderFixture(language, async (fixture) => {
      const actors: Dialog[] = [];
      const root = async (agent = 'tester', task = fixture.taskDocPath) => {
        const dialog = await fixture.root(agent, task);
        actors.push(dialog);
        return dialog;
      };
      const side = async (parent: MainDialog, id: string) => {
        const dialog = await fixture.side(parent, id);
        actors.push(dialog);
        return dialog;
      };
      const parent = await root('mentor');
      const a = await side(parent, 'migrate-side-a');
      const b = await side(parent, 'migrate-side-b');
      const crossRoot = await root('mentor-cross-root');
      const crossTask = await side(crossRoot, 'migrate-cross-task');
      const otherRoot = await root('mentor-other-task', fixture.otherTaskDocPath);
      const crossOtherTask = await side(otherRoot, 'migrate-other-task');
      const activeMain = await root();
      await fixture.lock(activeMain);
      const history = await root();
      const otherAgent = await root('other-agent');
      await fixture.lock(otherAgent);
      const givenBody = 'This shared task reminder turns out to belong only to side A';
      const added = await addReminderTool.call(a, fixture.caller, {
        content: givenBody,
        render_mode: 'plain',
      });
      assert.equal(added.outcome, 'success');
      const shared = (await a.listVisibleReminders()).find((reminder) => reminder.scope === 'task');
      assert.ok(shared);
      assert.equal(shared.content, givenBody);
      const givenMeta = { checkpoint: { sequence: 7, remaining: ['A', 'B'] } };
      // Declare opaque persisted work metadata as fixture data before testing the
      // public migration. It is not a new add_reminder argument or an owner capability.
      await mutateSharedReminders(
        { kind: 'task', agentId: 'tester', taskDocPath: fixture.taskDocPath },
        (reminders) => {
          const index = reminders.findIndex((reminder) => reminder.id === shared.id);
          assert.ok(index >= 0);
          reminders[index] = materializeReminder({ ...reminders[index]!, meta: givenMeta });
        },
      );
      const original = (await a.listVisibleReminders()).find(
        (reminder) => reminder.id === shared.id,
      );
      assert.ok(original);
      assert.equal(original.renderMode, 'plain');
      assert.deepEqual(original.meta, givenMeta);
      assert.ok(await sharedReminderFile(fixture.rtws, shared.id));
      for (const peer of [b, crossTask, activeMain, history]) {
        assert.equal(
          (await peer.listVisibleReminders()).some((reminder) => reminder.id === shared.id),
          true,
        );
      }
      for (const excluded of [crossOtherTask, otherAgent]) {
        assert.equal(
          (await excluded.listVisibleReminders()).some((reminder) => reminder.id === shared.id),
          false,
        );
      }
      const migrated = await migrateReminderTool.call(a, fixture.caller, {
        reminder_id: shared.id,
        scope: 'dialog',
      });
      assert.equal(migrated.outcome, 'success');
      const local = a.reminders.find((reminder) => reminder.id === shared.id);
      assert.ok(local);
      const expected = [{ ...reminderData([original])[0], scope: 'dialog' }];
      assert.deepEqual(reminderData([local]), expected);
      assert.equal(await sharedReminderFile(fixture.rtws, shared.id), undefined);
      for (const peer of [b, crossTask, activeMain, history, crossOtherTask, otherAgent]) {
        assert.equal(
          (await peer.listVisibleReminders()).some((reminder) => reminder.id === shared.id),
          false,
        );
      }
      const projected = await a.processReminderUpdates();
      const visibleLocal = projected.find((reminder) => reminder.reminder_id === shared.id);
      assert.ok(visibleLocal);
      assert.equal(visibleLocal.content, givenBody);
      assert.equal(visibleLocal.renderMode, 'plain');
      assert.deepEqual(visibleLocal.meta, givenMeta);
      const disk = await DialogPersistence.loadReminderState(a.id, a.status);
      assert.deepEqual(
        reminderData(disk.filter((reminder) => reminder.id === shared.id)),
        expected,
      );
      const later = await root();
      assert.equal(
        (await later.listVisibleReminders()).some((reminder) => reminder.id === shared.id),
        false,
      );
      await captureSharedNotices({
        language,
        id: 'task-migrated-private',
        scenario:
          'A default task-shared note is migrated to the updater Side Dialog with stable ID and complete plain body/opaque metadata preserved. Shared storage and peer visibility lose it; withdrawal is queued only to the original three active same-task peers, not history, another Taskdoc or another agent.',
        updater: a,
        reminderId: shared.id,
        scope: 'task',
        actors,
        recipients: [b, crossTask, activeMain],
        receipt: migrated,
        givenData: JSON.stringify({
          original: reminderData([original])[0],
          privateCopy: reminderData([local])[0],
        }),
        evidence,
      });
    });
  }
  await evidence.write();
  console.log(
    'Task-to-private reminder migration, actual withdrawal audience and disk fidelity: PASS',
  );
}
const watchdog = setTimeout(() => {
  throw new Error('Shared reminder migration did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
