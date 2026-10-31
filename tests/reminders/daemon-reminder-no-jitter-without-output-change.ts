import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { shellCmdReminderOwner } from '../../main/tools/os';
import { currentDaemon, withDaemonFixture } from '../helpers/daemon-reminders';
import { reminderData } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector(
  'dominds-daemon-daemon-reminder-no-jitter-without-output-change-',
);
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root } = fixture;
      const handle = await fixture.start();
      await root.processReminderUpdates();
      const before = {
        version: root.remindersVer,
        updatedAt: root.updatedAt,
        data: reminderData(await root.listVisibleReminders()),
        shared: JSON.parse(await fs.readFile(handle.sharedPath, 'utf8')),
      };
      const status = await handle.status();
      assert.equal(status.stdout.content, '');
      assert.equal(status.stderr.content, '');
      await root.processReminderUpdates();
      assert.deepEqual(
        {
          version: root.remindersVer,
          updatedAt: root.updatedAt,
          data: reminderData(await root.listVisibleReminders()),
          shared: JSON.parse(await fs.readFile(handle.sharedPath, 'utf8')),
        },
        before,
      );
      const payload = 'changed-output-data:72d8';
      await handle.send({ stdout: payload });
      await handle.waitOutput('stdout', payload);
      await root.processReminderUpdates();
      assert.ok(root.remindersVer > before.version);
      const after = await currentDaemon(root, handle.reminder.id);
      assert.ok(after.content.includes(payload));
      assert.equal(JSON.parse(await fs.readFile(handle.sharedPath, 'utf8')).content, after.content);
      const stableVersion = root.remindersVer;
      const stableData = reminderData(await root.listVisibleReminders());
      await root.processReminderUpdates();
      assert.equal(root.remindersVer, stableVersion);
      assert.deepEqual(reminderData(await root.listVisibleReminders()), stableData);
      evidence.record({
        id: language + '-output-change',
        scenario:
          'An owned daemon has no output, then a file-controlled action writes the supplied stdout payload, then no further output arrives.',
        businessValue: 'Avoid reminder version churn without suppressing real new output.',
        context: {
          language,
          payload,
          noOutputVersion: before.version,
          changedVersion: stableVersion,
          scope:
            'Real child/runner/owner/shared storage and public reminder version. This does not require zero writes or zero publication events.',
        },
        reviewQuestions: [
          'Does the actual reminder snapshot and rendered guidance accurately show the new output and ongoing running state without an unnecessary immediate user response or manual mirror instruction?',
        ],
        actualText: JSON.stringify(
          {
            snapshot: after.content,
            rendered: await shellCmdReminderOwner.renderReminder(root, after),
          },
          null,
          2,
        ),
      });
    });
  }
  await evidence.write();
  console.log('Daemon daemon-reminder-no-jitter-without-output-change: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Daemon case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
