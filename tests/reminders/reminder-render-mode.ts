import assert from 'node:assert/strict';
import type { MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { formatReminderItemGuide } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { FuncTool, ToolArguments } from '../../main/tool';
import { addReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-reminder-render-');
function state(dialog: MainDialog) {
  return structuredClone(
    dialog.reminders.map((reminder) => ({
      id: reminder.id,
      content: reminder.content,
      meta: reminder.meta,
      scope: reminder.scope,
      renderMode: reminder.renderMode,
      createdAt: reminder.createdAt,
      priority: reminder.priority,
      echoback: reminder.echoback,
      owner: reminder.owner?.name,
    })),
  );
}
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    setWorkLanguage('zh');
    const dialog = await createMainDialog();
    dialog.setLastUserLanguageCode('zh');
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    await dialog.processReminderUpdates();
    const known = new Set(dialog.reminders.map((reminder) => reminder.id));
    const markdownBody = '保持缩进：\n  - A\n  - B';
    const added = await addReminderTool.call(dialog, caller, {
      content: markdownBody,
      scope: 'dialog',
    });
    assert.equal(added.outcome, 'success');
    const created = dialog.reminders.filter((reminder) => !known.has(reminder.id));
    assert.equal(created.length, 1);
    const markdown = created[0]!;
    assert.equal(markdown.content, markdownBody);
    assert.equal(markdown.scope, 'dialog');
    assert.equal(markdown.renderMode, 'markdown');
    const updatedBody = '**Still** markdown after update\n  - 保留缩进';
    const updated = await updateReminderTool.call(dialog, caller, {
      reminder_id: markdown.id,
      content: updatedBody,
    });
    assert.equal(updated.outcome, 'success');
    const updatedMarkdown = dialog.reminders.find((reminder) => reminder.id === markdown.id);
    assert.ok(updatedMarkdown);
    assert.equal(updatedMarkdown.content, updatedBody);
    assert.equal(updatedMarkdown.renderMode, 'markdown');
    const plainBody = '**Literal asterisks wanted**\n```yaml\nnested:\n  - A\n```';
    const beforePlain = new Set(dialog.reminders.map((reminder) => reminder.id));
    const addedPlain = await addReminderTool.call(dialog, caller, {
      content: plainBody,
      scope: 'dialog',
      render_mode: 'plain',
    });
    assert.equal(addedPlain.outcome, 'success');
    const plainCreated = dialog.reminders.filter((reminder) => !beforePlain.has(reminder.id));
    assert.equal(plainCreated.length, 1);
    const plain = plainCreated[0]!;
    assert.equal(plain.content, plainBody);
    assert.equal(plain.renderMode, 'plain');
    const updatedPlainBody = '**Still literal** after update\n```yaml\nnested:\n  - B\n```';
    const plainUpdate = await updateReminderTool.call(dialog, caller, {
      reminder_id: plain.id,
      content: updatedPlainBody,
    });
    assert.equal(plainUpdate.outcome, 'success');
    const updatedPlain = dialog.reminders.find((reminder) => reminder.id === plain.id);
    assert.ok(updatedPlain);
    assert.equal(updatedPlain.content, updatedPlainBody);
    assert.equal(updatedPlain.renderMode, 'plain');
    const projected = await dialog.processReminderUpdates();
    const stored = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
    for (const expected of [updatedMarkdown, updatedPlain]) {
      const view = projected.find((reminder) => reminder.reminder_id === expected.id);
      const disk = stored.find((reminder) => reminder.id === expected.id);
      assert.ok(view && disk);
      assert.equal(view.content, expected.content);
      assert.equal(view.renderMode, expected.renderMode);
      assert.equal(disk.content, expected.content);
      assert.equal(disk.renderMode, expected.renderMode);
      assert.equal(disk.scope, expected.scope);
      const guides = (['zh', 'en'] as const).map((language) => {
        const actual = formatReminderItemGuide(language, expected.id, expected.content, {
          scope: expected.scope,
          meta: expected.meta,
        });
        assert.ok(actual.includes(expected.content)); // Complete supplied Markdown/code data, never generated meaning.
        return { language, actual };
      });
      evidence.record({
        id: expected.id === plain.id ? 'plain-reminder' : 'markdown-reminder',
        scenario:
          'Actual add/update tools preserve a supplied body and renderMode through visible projection and physical reminder storage.',
        businessValue:
          'Preserve the requested display mode and complete work data across tool updates and persistence.',
        context: {
          givenBody: expected.content,
          mode: expected.renderMode,
          scope:
            'Real Dialog/tools/store/formatter. This does not run a browser Markdown renderer or establish a restart.',
        },
        reviewQuestions: [
          'Do the actual tool receipts and reminder guides accurately describe this manually maintained reference, without rewriting its given body as a fresh instruction?',
        ],
        actualText: JSON.stringify(
          {
            toolReceipts: expected.id === plain.id ? [addedPlain, plainUpdate] : [added, updated],
            guides,
          },
          null,
          2,
        ),
      });
    }
    const invalid: { id: string; tool: FuncTool; args: ToolArguments }[] = [
      {
        id: 'invalid-add-scope',
        tool: addReminderTool,
        args: { content: 'rejected-data:bad-scope', scope: 'group' },
      },
      {
        id: 'invalid-add-mode',
        tool: addReminderTool,
        args: { content: 'rejected-data:bad-mode', scope: 'dialog', render_mode: 'html' },
      },
      {
        id: 'invalid-update-mode',
        tool: updateReminderTool,
        args: { reminder_id: markdown.id, content: 'must-not-replace-data', render_mode: 'html' },
      },
    ];
    for (const language of ['zh', 'en'] as const) {
      setWorkLanguage(language);
      // Resolving an update target also refreshes the fixed goal's localized view.
      // Settle that legitimate locale change before observing invalid-argument effects.
      await dialog.processReminderUpdates();
      for (const row of invalid) {
        const before = state(dialog),
          diskBefore = await DialogPersistence.loadReminderState(dialog.id, dialog.status);
        const output = await row.tool.call(dialog, caller, row.args);
        assert.equal(output.outcome, 'failure');
        assert.deepEqual(state(dialog), before);
        assert.deepEqual(
          await DialogPersistence.loadReminderState(dialog.id, dialog.status),
          diskBefore,
        );
        evidence.record({
          id: `${language}-${row.id}`,
          scenario:
            'An untrusted tool argument supplies an unsupported reminder scope or render mode; the tool refuses it and leaves observed memory/disk reminder state unchanged.',
          businessValue:
            'Reject unusable rendering/visibility configuration without losing existing work notes.',
          context: {
            language,
            input: JSON.stringify(row.args),
            tool: row.tool.name,
            scope:
              'Actual tool handler and actual Dialog/store; no browser or claim about write syscall counts.',
          },
          reviewQuestions: [
            'Does the actual refusal give an accurate, useful explanation for the supplied invalid arguments and avoid claiming a successful mutation?',
          ],
          actualText: output.content,
        });
      }
    }
    await evidence.write();
  });
  console.log('Reminder display modes, data fidelity, storage and refusal: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Reminder render case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
