import assert from 'node:assert/strict';
import { shellCmdReminderOwner } from '../../main/tools/os';
import {
  currentDaemon,
  jsonObject,
  processIsRunning,
  stopOwnedRunner,
  withDaemonFixture,
} from '../helpers/daemon-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-daemon-daemon-reminder-gone-exit-snapshot-');
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root } = fixture;
      const handle = await fixture.start();
      const payload = 'last-known-output-data:53b7';
      await handle.send({ stdout: payload });
      await handle.waitOutput('stdout', payload);
      await root.processReminderUpdates();
      const before = await currentDaemon(root, handle.reminder.id);
      await stopOwnedRunner(handle);
      const update = await shellCmdReminderOwner.updateReminder(root, before);
      assert.equal(update.treatment, 'update');
      if (update.treatment !== 'update') throw new Error('Expected finalized tracked state');
      assert.equal(jsonObject(update.updatedMeta).completed, true);
      assert.ok(update.updatedContent.includes(payload));
      await root.processReminderUpdates();
      const final = await currentDaemon(root, before.id);
      assert.equal(jsonObject(final.meta).completed, true);
      assert.equal(final.id, before.id);
      assert.ok(final.content.includes(payload));
      assert.equal(await processIsRunning(handle.meta.pid), false);
      const rendered = await shellCmdReminderOwner.renderReminder(root, final);
      evidence.record({
        id: language + '-gone-snapshot',
        scenario:
          'A genuinely started daemon and its runner are stopped through the real runner protocol, leaving their tracked reminder and an actual previous running snapshot for owner reconciliation.',
        businessValue:
          'Retain useful last-known output while removing the stale running interpretation after runner loss.',
        context: {
          language,
          givenPreviousRunningSnapshot: before.content,
          finalMetadata: JSON.stringify(final.meta),
          payload,
          actualProcessesRunning: false,
          scope:
            'Real runner loss and owner/shared storage. No crash/power-loss or backend exit-event delivery is claimed.',
        },
        reviewQuestions: [
          'Does the final text clearly represent terminal state, retain the actual last-known facts and avoid carrying a contradictory running claim or an invented immediate action?',
        ],
        actualText: JSON.stringify({ update, rendered }, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Daemon daemon-reminder-gone-exit-snapshot: PASS');
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
