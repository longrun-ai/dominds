import assert from 'node:assert/strict';
import path from 'node:path';
import type { Dialog, MainDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { MAIN_DIALOG_GOAL_REMINDER_ID } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { mutateSharedReminders } from '../../main/shared-reminders';
import { materializeReminder, type JsonObject, type ReminderOwner } from '../../main/tool';
import {
  addReminderTool,
  deleteReminderTool,
  migrateReminderTool,
  updateReminderTool,
} from '../../main/tools/ctrl';
import { registerReminderOwner, unregisterReminderOwner } from '../../main/tools/registry';
import { reminderData } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  captureSharedNotices,
  sharedNoticeState,
  sharedReminderFile,
  withSharedReminderFixture,
} from '../helpers/shared-reminders';

const evidence = semanticEvidenceCollector('dominds-shared-reminder-');
async function main() {
  for (const language of ['zh', 'en'] as const) {
    await withSharedReminderFixture(language, async (fixture) => {
      const actors: Dialog[] = [];
      const root = async (agent = 'tester', task = fixture.taskDocPath) => {
        const dialog = await fixture.root(agent, task);
        actors.push(dialog);
        return dialog;
      };
      const side = async (parent: MainDialog, callId: string) => {
        const dialog = await fixture.side(parent, callId);
        actors.push(dialog);
        return dialog;
      };
      const a = await root();
      const local = materializeReminder({
        id: 'dialog001',
        content: 'Older dialog reminder',
        createdAt: '2026-03-30T00:00:00.000Z',
        scope: 'dialog',
        renderMode: 'markdown',
      });
      a.reminders.push(local);
      const givenTask = 'Remember the preferred deploy smoke-check command for this task';
      const added = await addReminderTool.call(a, fixture.caller, { content: givenTask });
      assert.equal(added.outcome, 'success');
      const visibleA = (await a.listVisibleReminders()).filter(
        (row) => row.id !== MAIN_DIALOG_GOAL_REMINDER_ID,
      );
      const task = visibleA.find((row) => row.scope === 'task');
      assert.ok(task);
      assert.deepEqual(
        visibleA.map((row) => row.id),
        [task.id, local.id],
      );
      assert.equal(
        a.reminders.some((row) => row.id === task.id),
        false,
      );
      const storedTask = await sharedReminderFile(fixture.rtws, task.id);
      assert.ok(storedTask);
      assert.deepEqual(storedTask.relativePath.split(path.sep).slice(0, 2), [
        'agent_tasks',
        'tester',
      ]);
      assert.equal(storedTask.data.id, task.id);
      assert.equal(storedTask.data.scope, 'task');
      assert.equal(storedTask.data.renderMode, 'markdown');
      assert.equal(storedTask.data.content, givenTask);
      await captureSharedNotices({
        language,
        id: 'default-task-added',
        scenario:
          'Default add creates a task-shared work note, not a dialog-local copy. No active peer exists.',
        updater: a,
        reminderId: task.id,
        scope: 'task',
        actors,
        recipients: [],
        receipt: added,
        givenData: givenTask,
        evidence,
      });
      const b = await root();
      const otherTask = await root('tester', fixture.otherTaskDocPath);
      const otherAgent = await root('other-agent');
      await fixture.lock(otherAgent);
      assert.deepEqual(
        (await b.listVisibleReminders())
          .filter((row) => row.id !== MAIN_DIALOG_GOAL_REMINDER_ID)
          .map((row) => ({ id: row.id, content: row.content, scope: row.scope })),
        [{ id: task.id, content: givenTask, scope: 'task' }],
      );
      for (const dialog of [otherTask, otherAgent])
        assert.equal(
          (await dialog.listVisibleReminders()).some(
            (row) => row.id === task.id || row.id === local.id,
          ),
          false,
        );
      const loadedBody = 'Remember the loaded-only deploy smoke-check command';
      const loadedUpdate = await updateReminderTool.call(b, fixture.caller, {
        reminder_id: task.id,
        content: loadedBody,
      });
      assert.equal(loadedUpdate.outcome, 'success');
      assert.equal(
        (await a.listVisibleReminders()).find((row) => row.id === task.id)?.content,
        loadedBody,
      );
      await captureSharedNotices({
        language,
        id: 'loaded-history-excluded',
        scenario:
          'A shared task update is visible to another loaded same-task Main Dialog, but unlocked historical roots and a locked other-agent root are not current recipients.',
        updater: b,
        reminderId: task.id,
        scope: 'task',
        actors,
        recipients: [],
        receipt: loadedUpdate,
        givenData: loadedBody,
        evidence,
      });
      const singleRoot = await root('mentor-single');
      const single = await side(singleRoot, 'only-active-side');
      const singleBody = 'Remember the single-active deploy smoke-check command';
      const singleUpdate = await updateReminderTool.call(single, fixture.caller, {
        reminder_id: task.id,
        content: singleBody,
      });
      assert.equal(singleUpdate.outcome, 'success');
      await captureSharedNotices({
        language,
        id: 'only-updater-is-active',
        scenario:
          'The only active same-agent Side Dialog performs the update; do not send it a peer notification about its own change.',
        updater: single,
        reminderId: task.id,
        scope: 'task',
        actors,
        recipients: [],
        receipt: singleUpdate,
        givenData: singleBody,
        evidence,
      });
      globalDialogRegistry.unregister(singleRoot.id.rootId);
      const activeRoot = await root('mentor');
      const activeA = await side(activeRoot, 'active-side-a');
      const activeB = await side(activeRoot, 'active-side-b');
      const crossRoot = await root('mentor-cross-root');
      const crossTask = await side(crossRoot, 'same-task-cross-root');
      const otherRoot = await root('mentor-other-task', fixture.otherTaskDocPath);
      const crossOtherTask = await side(otherRoot, 'other-task-cross-root');
      const mainPeer = await root();
      await fixture.lock(mainPeer);
      const manualBody = 'Remember the active peer deploy smoke-check command';
      const manual = await updateReminderTool.call(activeA, fixture.caller, {
        reminder_id: task.id,
        content: manualBody,
      });
      assert.equal(manual.outcome, 'success');
      await captureSharedNotices({
        language,
        id: 'active-task-manual-update',
        scenario:
          'A task change reaches the same-root Side, cross-root same-task Side and locked same-task Main. Different-task, other-agent, historical and updater dialogs are excluded.',
        updater: activeA,
        reminderId: task.id,
        scope: 'task',
        actors,
        recipients: [activeB, crossTask, mainPeer],
        receipt: manual,
        givenData: manualBody,
        evidence,
      });
      const ownerId = 'owner-' + language + '-001';
      let refreshOwner = false;
      let ownerCalls = 0;
      const owner: ReminderOwner = {
        name: 'task-agent-reminder-scope-auto-owner',
        async updateReminder(_dialog, reminder) {
          ownerCalls++;
          const updatedMeta: JsonObject = refreshOwner
            ? { ownerUpdated: true }
            : { nested: { b: 2, a: 1 }, state: 'same' };
          return {
            treatment: 'update',
            updatedContent: refreshOwner ? 'Owner refreshed shared state' : reminder.content,
            updatedMeta,
          };
        },
        async renderReminder(_dialog, reminder) {
          return { type: 'transient_guide_msg', role: 'assistant', content: reminder.content };
        },
      };
      registerReminderOwner(owner);
      try {
        await mutateSharedReminders(
          { kind: 'task', agentId: 'tester', taskDocPath: fixture.taskDocPath },
          (reminders) => {
            reminders.push(
              materializeReminder({
                id: ownerId,
                content: 'Owner stale shared state',
                owner,
                meta: { state: 'same', nested: { a: 1, b: 2 } },
                scope: 'task',
                createdAt: '2026-03-30T00:00:01.000Z',
                priority: 'medium',
                renderMode: 'markdown',
              }),
            );
          },
        );
        const before = await sharedNoticeState(actors);
        const fileBefore = await sharedReminderFile(fixture.rtws, ownerId);
        await activeB.processReminderUpdates();
        assert.equal(ownerCalls, 1);
        assert.deepEqual(await sharedNoticeState(actors), before);
        assert.deepEqual(await sharedReminderFile(fixture.rtws, ownerId), fileBefore);
        refreshOwner = true;
        await activeB.processReminderUpdates();
        assert.equal(ownerCalls, 2);
        const ownerFile = await sharedReminderFile(fixture.rtws, ownerId);
        assert.ok(ownerFile);
        assert.equal(ownerFile.data.ownerName, owner.name);
        assert.equal(ownerFile.data.content, 'Owner refreshed shared state');
        assert.deepEqual(ownerFile.data.meta, { ownerUpdated: true });
        assert.equal(
          (await activeB.listVisibleReminders()).find((row) => row.id === task.id)?.content,
          manualBody,
        );
        await captureSharedNotices({
          language,
          id: 'active-task-owner-update',
          scenario:
            'A registered owner really changes task state after an equivalent-key-order control produced no new memory/disk scheduling state. The actual change reaches three intended same-task peers.',
          updater: activeB,
          reminderId: ownerId,
          scope: 'task',
          actors,
          recipients: [activeA, crossTask, mainPeer],
          givenData: JSON.stringify({
            content: 'Owner refreshed shared state',
            meta: { ownerUpdated: true },
          }),
          evidence,
        });
        const ownedBefore = {
          local: reminderData(activeB.reminders),
          localDisk: reminderData(
            await DialogPersistence.loadReminderState(activeB.id, activeB.status),
          ),
          shared: await sharedReminderFile(fixture.rtws, ownerId),
          notices: await sharedNoticeState(actors),
        };
        const ownedMigration = await migrateReminderTool.call(activeB, fixture.caller, {
          reminder_id: ownerId,
          scope: 'dialog',
        });
        assert.equal(ownedMigration.outcome, 'failure');
        assert.equal(ownerCalls, 2);
        assert.deepEqual(
          {
            local: reminderData(activeB.reminders),
            localDisk: reminderData(
              await DialogPersistence.loadReminderState(activeB.id, activeB.status),
            ),
            shared: await sharedReminderFile(fixture.rtws, ownerId),
            notices: await sharedNoticeState(actors),
          },
          ownedBefore,
        );
        evidence.record({
          id: language + '-owner-migration-refused',
          scenario:
            'The same actual owner-maintained shared note cannot be migrated through the manual tool; the tool refuses without changing private/shared/durable queued state.',
          businessValue:
            'Keep automated state under its owning capability rather than advertise or permit a manual migration that cannot preserve its lifecycle.',
          context: {
            language,
            reminderId: ownerId,
            owner: owner.name,
            givenData: JSON.stringify(ownerFile.data),
            scopeLimit:
              'Actual tool handler and complete local/shared/queue state; this does not invoke an owner management command or discover a new capability.',
          },
          reviewQuestions: [
            'Does the actual refusal accurately explain the automatic maintenance boundary without claiming a migration happened or inventing a maintenance action?',
          ],
          actualText: ownedMigration.content,
        });
        const agentBody = 'Urgent: confirm before deleting external resources';
        const agentAdded = await addReminderTool.call(activeA, fixture.caller, {
          content: agentBody,
          scope: 'agent',
        });
        assert.equal(agentAdded.outcome, 'success');
        const agent = (await otherTask.listVisibleReminders()).find((row) => row.scope === 'agent');
        assert.ok(agent);
        const agentFile = await sharedReminderFile(fixture.rtws, agent.id);
        assert.ok(agentFile);
        assert.deepEqual(agentFile.relativePath.split(path.sep).slice(0, 2), ['agents', 'tester']);
        assert.equal(agentFile.data.scope, 'agent');
        assert.equal(agentFile.data.content, agentBody);
        assert.equal(agentFile.data.id, agent.id);
        assert.equal(
          (await otherAgent.listVisibleReminders()).some(
            (row) => row.id === task.id || row.id === agent.id,
          ),
          false,
        );
        evidence.record({
          id: language + '-agent-added',
          scenario:
            'An explicitly agent-shared work note is visible across this agent Taskdocs and excluded from another agent.',
          businessValue:
            'Keep urgent global notes visible to their owner agent without crossing agent isolation.',
          context: {
            language,
            givenContent: agentBody,
            reminderId: agent.id,
            scopeLimit:
              'Actual handler, visibility and agent-namespace JSON; the note is given data, no external deletion or permission action runs.',
          },
          reviewQuestions: [
            'Does the actual receipt agree with creating this shared work note without claiming an external operation?',
          ],
          actualText: agentAdded.content,
        });
        const agentUpdatedBody = 'Urgent: confirm twice before deleting external resources';
        const agentUpdate = await updateReminderTool.call(activeB, fixture.caller, {
          reminder_id: agent.id,
          content: agentUpdatedBody,
        });
        assert.equal(agentUpdate.outcome, 'success');
        await captureSharedNotices({
          language,
          id: 'active-agent-manual-update',
          scenario:
            'An agent-scoped update also reaches the active same-agent Side on another Taskdoc; the other-agent, historical and updater dialogs remain excluded.',
          updater: activeB,
          reminderId: agent.id,
          scope: 'agent',
          actors,
          recipients: [activeA, crossTask, crossOtherTask, mainPeer],
          receipt: agentUpdate,
          givenData: agentUpdatedBody,
          evidence,
        });
        const taskDeleted = await deleteReminderTool.call(b, fixture.caller, {
          reminder_id: task.id,
        });
        assert.equal(taskDeleted.outcome, 'success');
        assert.equal(await sharedReminderFile(fixture.rtws, task.id), undefined);
        const afterDelete = await b.listVisibleReminders();
        assert.equal(
          afterDelete.some((row) => row.id === task.id),
          false,
        );
        assert.equal(
          afterDelete.find((row) => row.id === ownerId)?.content,
          'Owner refreshed shared state',
        );
        assert.equal(afterDelete.find((row) => row.id === agent.id)?.content, agentUpdatedBody);
        const agentDeleted = await deleteReminderTool.call(otherTask, fixture.caller, {
          reminder_id: agent.id,
        });
        assert.equal(agentDeleted.outcome, 'success');
        assert.equal(await sharedReminderFile(fixture.rtws, agent.id), undefined);
        assert.deepEqual(
          (await otherTask.listVisibleReminders()).filter(
            (row) => row.id !== MAIN_DIALOG_GOAL_REMINDER_ID,
          ),
          [],
        );
        assert.equal(
          (await a.listVisibleReminders()).find((row) => row.id === local.id)?.content,
          local.content,
        );
        evidence.record({
          id: language + '-independent-shared-deletions',
          scenario:
            'A different same-task dialog deletes the manual task item while owner/agent items stay; a different Taskdoc then deletes the agent item. Private original data remain.',
          businessValue:
            'Remove only the selected shared work without losing independently owned or private state.',
          context: {
            language,
            taskReminderId: task.id,
            agentReminderId: agent.id,
            preservedOwnerReminderId: ownerId,
            scopeLimit:
              'Actual handlers, visibility and physical shared file absence; no delete-notification policy or external resource operation is established.',
          },
          reviewQuestions: [
            'Do the actual two deletion receipts fit the observed item removals without implying broader state removal?',
          ],
          actualText: JSON.stringify({ taskDeleted, agentDeleted }, null, 2),
        });
      } finally {
        unregisterReminderOwner(owner.name);
      }
    });
  }
  await evidence.write();
  console.log('Shared task/agent visibility, actual recipient routing and disk state: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Shared reminder scope case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
