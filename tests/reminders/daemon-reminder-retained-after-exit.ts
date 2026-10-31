import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deleteReminderTool, updateReminderTool } from '../../main/tools/ctrl';
import { getDaemonOutputTool, shellCmdReminderOwner } from '../../main/tools/os';
import {
  currentDaemon,
  jsonObject,
  processIsRunning,
  withDaemonFixture,
} from '../helpers/daemon-reminders';
import { reminderData } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { waitFor } from '../kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-daemon-daemon-reminder-retained-after-exit-');
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root, caller } = fixture;
      const handle = await fixture.start();
      const stdout = 'final-stdout-data:4f82';
      const stderr = 'final-stderr-data:51a3';
      await handle.send({ stdout, stderr });
      await handle.waitOutput('stdout', stdout);
      await handle.waitOutput('stderr', stderr);
      await root.processReminderUpdates();
      const knownBeforeExit = await currentDaemon(root, handle.reminder.id);
      assert.ok(
        knownBeforeExit.content.includes(stdout) && knownBeforeExit.content.includes(stderr),
      );
      await handle.send({ exitCode: 7 });
      await waitFor(
        async () =>
          !(await processIsRunning(handle.meta.pid)) &&
          !(await processIsRunning(handle.meta.runnerPid)),
        3_000,
        'actual controlled daemon exit',
      );
      await root.processReminderUpdates();
      const final = await currentDaemon(root, handle.reminder.id);
      assert.equal(jsonObject(final.meta).completed, true);
      assert.equal(jsonObject(final.meta).delete, undefined);
      assert.ok(final.content.includes(stdout));
      assert.ok(final.content.includes(stderr));
      const saved = JSON.parse(await fs.readFile(handle.sharedPath, 'utf8'));
      assert.equal(saved.content, final.content);
      assert.deepEqual(saved.meta, final.meta);
      const version = root.remindersVer;
      const finalData = reminderData(await root.listVisibleReminders());
      await root.processReminderUpdates();
      assert.equal(root.remindersVer, version);
      assert.deepEqual(reminderData(await root.listVisibleReminders()), finalData);
      const rendered = await shellCmdReminderOwner.renderReminder(root, final);
      const savedBytes = await fs.readFile(handle.sharedPath, 'utf8');
      const unavailable = await getDaemonOutputTool.call(root, caller, { pid: handle.meta.pid });
      assert.equal(unavailable.outcome, 'failure');
      assert.equal(
        (await root.listVisibleReminders()).some((row) => row.id === final.id),
        true,
        'Reading an unavailable runner must preserve the saved terminal reminder',
      );
      assert.equal(await fs.readFile(handle.sharedPath, 'utf8'), savedBytes);
      assert.equal(root.remindersVer, version);
      const refusedEdit = await updateReminderTool.call(root, caller, {
        reminder_id: final.id,
        content: 'replacement-data:terminal-snapshot-536e',
      });
      assert.equal(refusedEdit.outcome, 'failure');
      assert.equal(await fs.readFile(handle.sharedPath, 'utf8'), savedBytes);
      const deleted = await deleteReminderTool.call(root, caller, { reminder_id: final.id });
      assert.equal(deleted.outcome, 'success');
      assert.equal(
        (await root.listVisibleReminders()).some((row) => row.id === final.id),
        false,
      );
      await assert.rejects(fs.readFile(handle.sharedPath, 'utf8'), { code: 'ENOENT' });
      evidence.record({
        id: language + '-retained-exit',
        scenario:
          'A real daemon checkpoints last-known stdout/stderr, then both daemon and runner exit after a declared code7 request. The same completed reminder survives another refresh, an unavailable output read and a refused manual edit before actual manual deletion succeeds.',
        businessValue:
          'Keep terminal facts available until explicitly cleared, while releasing the running-process deletion restriction.',
        context: {
          language,
          stdout,
          stderr,
          observedDaemonRunning: await processIsRunning(handle.meta.pid),
          observedRunnerRunning: await processIsRunning(handle.meta.runnerPid),
          givenRequestedExitCode: 7,
          actualKnownSnapshotBeforeExit: knownBeforeExit.content,
          persistedTerminalState: JSON.stringify(saved),
          scope:
            'Actual local process exit/owner/shared storage/manual deletion. Runner exits with its child by the existing contract: this preserves the genuinely saved last-known snapshot, not unobserved final bytes or an observed numeric exit code. This is not a runner crash, independent-process recovery or backend wake delivery.',
        },
        reviewQuestions: [
          'Do the saved terminal guidance, unavailable-output refusal and manual-edit refusal give an accurate usable maintenance path while preserving last-known facts, and does the deletion receipt agree with the actual successful removal?',
        ],
        actualText: JSON.stringify(
          { terminal: final.content, rendered, unavailable, refusedEdit, deleted },
          null,
          2,
        ),
      });
    });
  }
  await evidence.write();
  console.log('Daemon daemon-reminder-retained-after-exit: PASS');
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
