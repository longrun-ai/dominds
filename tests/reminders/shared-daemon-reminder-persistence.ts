import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  getDaemonOutputTool,
  resetTrackedDaemonsForTests,
  shellCmdReminderOwner,
  stopDaemonTool,
} from '../../main/tools/os';
import {
  currentDaemon,
  daemonMeta,
  processIsRunning,
  withDaemonFixture,
} from '../helpers/daemon-reminders';
import { reminderData } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { waitFor } from '../kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-daemon-shared-daemon-reminder-persistence-');
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root, caller } = fixture;
      const handle = await fixture.start();
      const stdout = 'shared-stdout-data:0b6f';
      const stderr = 'shared-stderr-data:2d85';
      await handle.send({ stdout, stderr });
      await handle.waitOutput('stdout', stdout);
      await handle.waitOutput('stderr', stderr);
      await root.processReminderUpdates();
      const stored = JSON.parse(await fs.readFile(handle.sharedPath, 'utf8'));
      assert.equal(stored.id, handle.reminder.id);
      assert.equal(stored.ownerName, 'shellCmd');
      assert.equal(stored.scope, 'runtime');
      assert.equal(stored.renderMode, 'markdown');
      assert.equal(stored.meta.kind, 'daemon');
      assert.equal(stored.meta.pid, handle.meta.pid);
      assert.equal(stored.meta.runnerPid, handle.meta.runnerPid);
      assert.equal(stored.meta.runnerEndpoint, handle.meta.runnerEndpoint);
      assert.equal(stored.meta.initialCommandLine, handle.meta.initialCommandLine);
      assert.equal(stored.meta.daemonCommandLine, handle.meta.daemonCommandLine);
      const same = await fixture.rootFor();
      assert.deepEqual(
        reminderData([await currentDaemon(same, handle.reminder.id)]),
        reminderData([await currentDaemon(root, handle.reminder.id)]),
      );
      const different = await fixture.rootFor('other-agent');
      assert.equal(
        (await different.listVisibleReminders()).some((row) => row.id === handle.reminder.id),
        false,
      );
      resetTrackedDaemonsForTests();
      const recovered = await currentDaemon(same, handle.reminder.id);
      assert.equal(daemonMeta(recovered).runnerEndpoint, handle.meta.runnerEndpoint);
      const rendered = await shellCmdReminderOwner.renderReminder(same, recovered);
      const output = await getDaemonOutputTool.call(same, caller, { pid: handle.meta.pid });
      assert.equal(output.outcome, 'success');
      assert.ok(output.content.includes(stdout));
      assert.ok(output.content.includes(stderr));
      const stopped = await stopDaemonTool.call(same, caller, { pid: handle.meta.pid });
      assert.equal(stopped.outcome, 'success');
      await waitFor(
        async () => !(await processIsRunning(handle.meta.pid)),
        3_000,
        'same-agent recovered owned daemon to stop',
      );
      for (const dialog of [root, same, different])
        assert.equal(
          (await dialog.listVisibleReminders()).some((row) => row.id === handle.reminder.id),
          false,
        );
      await assert.rejects(fs.readFile(handle.sharedPath, 'utf8'), { code: 'ENOENT' });
      evidence.record({
        id: language + '-shared-recovery',
        scenario:
          'A real agent-scoped daemon record is read by another same-agent dialog, hidden from a different agent, then used for real output retrieval and stopping after an in-memory registry reset.',
        businessValue:
          'Let ongoing work remain inspectable and controllable across dialogs without leaking capability/state to another agent.',
        context: {
          language,
          stdout,
          stderr,
          persistedRecord: JSON.stringify(stored),
          scope:
            'Real shared files, native dialogs, child process and runner IPC. Registry reset/new dialog is not an independent-process restart or abrupt-kill recovery.',
        },
        reviewQuestions: [
          'Does the actual recovered rendering, output and stop guidance accurately reflect the running process/stream facts and maintenance capabilities without claiming stronger restart or agent-isolation evidence than this scenario provides?',
        ],
        actualText: JSON.stringify({ rendered, output, stopped }, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Daemon shared-daemon-reminder-persistence: PASS');
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
