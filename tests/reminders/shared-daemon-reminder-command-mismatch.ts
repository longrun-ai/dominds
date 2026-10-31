import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  getDaemonOutputTool,
  resetTrackedDaemonsForTests,
  stopDaemonTool,
} from '../../main/tools/os';
import { processIsRunning, withDaemonFixture } from '../helpers/daemon-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { waitFor } from '../kernel-driver/helpers';
const evidence = semanticEvidenceCollector(
  'dominds-daemon-shared-daemon-reminder-command-mismatch-',
);
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root, caller } = fixture;
      const handle = await fixture.start();
      const original = JSON.parse(await fs.readFile(handle.sharedPath, 'utf8'));
      const altered = structuredClone(original);
      altered.meta.daemonCommandLine = 'unrelated-command-data:5c3b';
      await fs.writeFile(handle.sharedPath, JSON.stringify(altered) + '\n');
      resetTrackedDaemonsForTests();
      const other = await fixture.rootFor();
      const refused = await stopDaemonTool.call(other, caller, { pid: handle.meta.pid });
      assert.equal(refused.outcome, 'failure');
      assert.equal(await processIsRunning(handle.meta.pid), true);
      assert.equal((await handle.status()).isRunning, true);
      const payload = 'after-mismatch-output-data:3c7d';
      await handle.send({ stdout: payload });
      await handle.waitOutput('stdout', payload);
      // The refusal removes the stale record; restoring its actual original identity
      // is an explicit fixture repair, followed by a real read/stop positive control.
      await fs.writeFile(handle.sharedPath, JSON.stringify(original) + '\n');
      const output = await getDaemonOutputTool.call(other, caller, { pid: handle.meta.pid });
      assert.equal(output.outcome, 'success');
      assert.ok(output.content.includes(payload));
      const stopped = await stopDaemonTool.call(other, caller, { pid: handle.meta.pid });
      assert.equal(stopped.outcome, 'success');
      await waitFor(
        async () => !(await processIsRunning(handle.meta.pid)),
        3_000,
        'actual original owned process to stop',
      );
      assert.equal(
        (await other.listVisibleReminders()).some((row) => row.id === handle.reminder.id),
        false,
      );
      evidence.record({
        id: language + '-identity-mismatch',
        scenario:
          'The actual shared runner record keeps its PID/start time but its daemon command identity is deliberately replaced. A fresh same-agent dialog refuses to stop it and the process produces more output; explicit fixture restoration then enables actual read and stop.',
        businessValue:
          'Prevent PID-only recovery from killing an unrelated process while preserving a functioning legitimate recovery path.',
        context: {
          language,
          pid: handle.meta.pid,
          actualOriginalIdentity: JSON.stringify(handle.meta),
          givenAlteredIdentity: altered.meta.daemonCommandLine,
          payload,
          scope:
            'Real runner/process/native tools and a new dialog after in-memory registry reset. Explicit metadata repair is fixture input, not autonomous self-healing or an independent-process restart.',
        },
        reviewQuestions: [
          'Does the refusal accurately avoid claiming a stop, and do the later output/stop receipts describe the successful repaired-identity controls without claiming the corrupted record was safely recoverable?',
        ],
        actualText: JSON.stringify({ refused, output, stopped }, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Daemon shared-daemon-reminder-command-mismatch: PASS');
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
