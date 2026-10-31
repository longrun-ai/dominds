import assert from 'node:assert/strict';
import type { AppsHostClient, EnabledAppForHost } from '../../main/apps-host/client';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder } from '../../main/tool';
import {
  applyAppReminderRequests,
  buildAppReminderOwnerRegistryName,
  ensureAppReminderOwnersRegistered,
  unregisterAppReminderOwnersForApps,
} from '../../main/tools/app-reminders';
import { getReminderOwner } from '../../main/tools/registry';
import { recordDialogEvents } from '../helpers/dialog-events';
import {
  manualReminderSnapshot,
  reminderData,
  withManualReminderDialog,
} from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-component-reminder-');
async function main() {
  for (const language of ['en', 'zh'] as const)
    await withManualReminderDialog(language, async (dialog) => {
      const appId = '@tests/render-mode-preserve-' + language;
      const ownerRef = 'observer';
      const descriptor: EnabledAppForHost = {
        appId,
        runtimePort: null,
        hostSourceVersion: null,
        installJson: {
          appId,
          package: { name: appId, version: '0.0.0-test', rootAbs: process.cwd() },
          host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'default' },
          contributes: { reminderOwners: [{ ref: ownerRef }] },
        },
      };
      let applyMode: 'valid' | 'non_finite_position' | 'negative_zero_position' = 'valid';
      const applyCalls: Parameters<AppsHostClient['applyReminder']>[] = [];
      const updateCalls: Parameters<AppsHostClient['updateReminder']>[] = [];
      const renderCalls: Parameters<AppsHostClient['renderReminder']>[] = [];
      const failure = new Error('component-boundary-failure-data:368f');
      const componentContent = 'component-content-data:8b62';
      const renderedBody = 'component-render-data:3a5e';
      const client: AppsHostClient = {
        async callTool() {
          throw new Error('Tool invocation is outside this owner-adapter case');
        },
        async applyReminder(...args) {
          applyCalls.push(args);
          if (applyMode !== 'valid')
            return {
              treatment: 'add',
              position: applyMode === 'non_finite_position' ? NaN : -0,
              reminder: { content: 'invalid-position-data:3e71' },
            };
          return {
            treatment: 'update',
            ownedIndex: 0,
            reminder: { content: componentContent, meta: { foo: 'baz' }, echoback: true },
          };
        },
        async updateReminder(...args) {
          updateCalls.push(args);
          throw failure;
        },
        async renderReminder(...args) {
          renderCalls.push(args);
          return { content: renderedBody };
        },
        async shutdown() {},
      };
      ensureAppReminderOwnersRegistered({
        enabledApps: [descriptor],
        resolveHostClient: async () => client,
      });
      try {
        const registryName = buildAppReminderOwnerRegistryName(appId, ownerRef);
        const owner = getReminderOwner(registryName);
        assert.ok(owner);
        const originalContent = 'original-owned-data:5c2a';
        const original = materializeReminder({
          content: originalContent,
          owner,
          scope: 'dialog',
          renderMode: 'plain',
          meta: {
            kind: 'app_reminder_owner',
            appId,
            ownerRef,
            manager: { tool: ownerRef },
            foo: 'bar',
          },
          echoback: false,
          createdAt: '2001-01-01 00:00:00',
          priority: 'medium',
        });
        dialog.reminders.push(original);
        dialog.touchReminders();
        await dialog.dlgStore.persistReminders(dialog, dialog.reminders);
        const base = await manualReminderSnapshot(dialog);
        const request = { kind: 'upsert' as const, ownerRef, content: 'request-data:41b7' };
        const recorded = recordDialogEvents(dialog);
        await applyAppReminderRequests(dialog, {
          appId,
          reminderRequests: [request],
          resolveHostClient: async () => client,
        });
        const events = await recorded.finish();
        assert.deepEqual(applyCalls[0], [
          appId,
          ownerRef,
          request,
          {
            dialogId: dialog.id.selfId,
            ownedReminders: [
              {
                content: originalContent,
                meta: { foo: 'bar' },
                echoback: false,
                renderMode: 'plain',
              },
            ],
          },
        ]);
        assert.equal(applyCalls.length, 1);
        const reminder = dialog.reminders.find((row) => row.id === original.id);
        assert.ok(reminder);
        assert.equal(dialog.reminders.filter((row) => row.owner === owner).length, 1);
        assert.equal(reminder.content, componentContent);
        assert.equal(reminder.renderMode, 'plain');
        assert.equal(reminder.echoback, true);
        assert.equal(reminder.scope, 'dialog');
        assert.deepEqual(reminder.meta, {
          foo: 'baz',
          kind: 'app_reminder_owner',
          appId,
          ownerRef,
          manager: { tool: ownerRef },
        });
        assert.equal(dialog.remindersVer, base.remindersVer + 1);
        assert.deepEqual(
          reminderData(await DialogPersistence.loadReminderState(dialog.id, dialog.status)),
          reminderData(dialog.reminders),
        );
        const full = events.filter((event) => event.type === 'full_reminders_update');
        assert.equal(full.length, 1);
        const published = full[0]!.reminders.find((row) => row.reminder_id === original.id);
        assert.ok(published);
        assert.equal(published.renderMode, 'plain');
        assert.equal(published.echoback, true);
        assert.equal(published.content, componentContent);
        const rendered = await owner.renderReminder(dialog, reminder);
        assert.equal(rendered.type, 'environment_msg');
        assert.equal(rendered.role, 'user');
        assert.ok('content' in rendered && rendered.content.includes(renderedBody));
        assert.ok(rendered.content.includes(original.id)); // Complete supplied identity data.
        assert.equal(renderCalls.length, 1);
        assert.deepEqual(renderCalls[0], [
          appId,
          ownerRef,
          {
            dialogId: dialog.id.selfId,
            reminder: {
              content: componentContent,
              meta: { foo: 'baz' },
              echoback: true,
              renderMode: 'plain',
            },
            reminderId: original.id,
            workLanguage: language,
          },
        ]);
        const stable = await manualReminderSnapshot(dialog);
        let observed: unknown;
        try {
          await owner.updateReminder(dialog, reminder);
        } catch (error) {
          observed = error;
        }
        assert.equal(observed, failure);
        assert.equal(updateCalls.length, 1);
        assert.deepEqual(await manualReminderSnapshot(dialog), stable);
        evidence.record({
          id: language + '-owned-update-render',
          scenario:
            'A real registered reminder owner delegates to a controlled external host client. The actual kernel update preserves plain mode, persists full owned data and publishes one complete snapshot. Rendering forwards the given component body; a host update failure propagates its original cause.',
          businessValue:
            'Keep extension-owned state, output fidelity and failure visibility intact through the current compatibility bridge.',
          context: {
            language,
            appId,
            ownerRef,
            actualReminder: JSON.stringify(reminderData([reminder])),
            givenRenderedBody: renderedBody,
            actualCalls: JSON.stringify({ apply: applyCalls, render: renderCalls }),
            scope:
              'Real dialog/store/registry/kernel owner bridge; only the external AppsHostClient is controlled. The manager name is declared fixture metadata, not an exercised maintenance tool. No host IPC/process, browser delivery or future App architecture is established.',
          },
          reviewQuestions: [
            'Does the actual wrapper accurately present this given body as component-maintained state, preserve reminder identity and discourage redundant manual mirrors without claiming a maintenance action or user reply occurred?',
          ],
          actualText: JSON.stringify({ rendered, injectedFailure: failure.message }, null, 2),
        });

        const diagnostics: { stage: string; error: string }[] = [];
        const corrupt = materializeReminder({
          content: 'corrupt-owned-data:42c7',
          owner,
          meta: { ownerState: 'missing-kernel-wrapper-data' },
          scope: 'dialog',
          renderMode: 'markdown',
          createdAt: '2001-01-01 00:00:00',
          priority: 'medium',
        });
        for (const [stage, action] of [
          ['update', () => owner.updateReminder(dialog, corrupt)],
          ['render', () => owner.renderReminder(dialog, corrupt)],
        ] as const) {
          let error: unknown;
          try {
            await action();
          } catch (value) {
            error = value;
          }
          assert.ok(error instanceof Error);
          diagnostics.push({ stage, error: error.message });
          assert.deepEqual(await manualReminderSnapshot(dialog), stable);
        }
        assert.equal(updateCalls.length, 1);
        assert.equal(renderCalls.length, 1);
        for (const mode of ['non_finite_position', 'negative_zero_position'] as const) {
          applyMode = mode;
          let error: unknown;
          try {
            await applyAppReminderRequests(dialog, {
              appId,
              reminderRequests: [request],
              resolveHostClient: async () => client,
            });
          } catch (value) {
            error = value;
          }
          assert.ok(error instanceof Error);
          diagnostics.push({ stage: mode, error: error.message });
          assert.deepEqual(await manualReminderSnapshot(dialog), stable);
        }
        assert.equal(applyCalls.length, 3);
        applyMode = 'valid';
        dialog.reminders.push(corrupt);
        dialog.touchReminders();
        await dialog.dlgStore.persistReminders(dialog, dialog.reminders);
        const corruptState = await manualReminderSnapshot(dialog);
        let error: unknown;
        try {
          await applyAppReminderRequests(dialog, {
            appId,
            reminderRequests: [request],
            resolveHostClient: async () => client,
          });
        } catch (value) {
          error = value;
        }
        assert.ok(error instanceof Error);
        diagnostics.push({ stage: 'collect', error: error.message });
        assert.equal(applyCalls.length, 3);
        assert.equal(updateCalls.length, 1);
        assert.equal(renderCalls.length, 1);
        assert.deepEqual(await manualReminderSnapshot(dialog), corruptState);
        evidence.record({
          id: language + '-owned-invariant-refusals',
          scenario:
            'The kernel bridge refuses a malformed owned wrapper for update/render/collect and non-lossless insertion positions NaN/-0 from the controlled host. State and call counts establish where delegation stopped.',
          businessValue:
            'Reject ambiguous owned state before delegation or mutation, preserving useful reminders and actionable fault evidence.',
          context: {
            language,
            appId,
            ownerRef,
            reminderId: original.id,
            corruptReminderId: corrupt.id,
            givenCorruptMeta: JSON.stringify(corrupt.meta),
            actualCalls: JSON.stringify({
              apply: applyCalls.length,
              update: updateCalls.length,
              render: renderCalls.length,
            }),
            scope:
              'Real kernel owner bridge, disk and public state; controlled external host result. Numeric failure inputs are NaN and negative zero, not string values. No live component, browser or architecture migration is claimed.',
          },
          reviewQuestions: [
            'Do these actual diagnostics accurately identify the given wrapper/position failures and relevant owner/dialog/reminder boundaries without implying mutation succeeded or inventing an available repair action?',
          ],
          actualText: JSON.stringify(diagnostics, null, 2),
        });
      } finally {
        unregisterAppReminderOwnersForApps({ appIds: [appId] });
      }
    });
  await evidence.write();
  console.log('Component reminder state and render-mode compatibility: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
