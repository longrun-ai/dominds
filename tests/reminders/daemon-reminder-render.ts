import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deleteReminderTool } from '../../main/tools/ctrl';
import { shellCmdReminderOwner } from '../../main/tools/os';
import { currentDaemon, withDaemonFixture } from '../helpers/daemon-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-daemon-daemon-reminder-render-');
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root, caller } = fixture;
      const handle = await fixture.start();
      const stdout = 'running-stdout-data:264e';
      const stderr = 'running-stderr-data:93bf';
      await handle.send({ stdout, stderr });
      await handle.waitOutput('stdout', stdout);
      await handle.waitOutput('stderr', stderr);
      await root.processReminderUpdates();
      const reminder = await currentDaemon(root, handle.reminder.id);
      const before = await fs.readFile(handle.sharedPath, 'utf8');
      const refused = await deleteReminderTool.call(root, caller, { reminder_id: reminder.id });
      assert.equal(refused.outcome, 'failure');
      assert.equal(await fs.readFile(handle.sharedPath, 'utf8'), before);
      assert.equal((await handle.status()).isRunning, true);
      const rendered = await shellCmdReminderOwner.renderReminder(root, reminder);
      assert.equal(rendered.type, 'environment_msg');
      assert.equal(rendered.role, 'user');
      assert.ok('content' in rendered && typeof rendered.content === 'string');
      assert.ok(rendered.content.includes(stdout));
      assert.ok(rendered.content.includes(stderr));
      evidence.record({
        id: language + '-running-start-render',
        scenario:
          'The real shell tool exceeded its one-second foreground deadline, created an agent-shared runtime reminder, and the still-running owned child produced both supplied stream payloads. Actual manual delete was refused.',
        businessValue:
          'Give the executing agent an accurate lifecycle signal and maintenance path, preserving original output and avoiding duplicate manual state.',
        context: {
          language,
          pid: handle.meta.pid,
          initialCommand: handle.meta.initialCommandLine,
          stdout,
          stderr,
          actualStatus: JSON.stringify(await handle.status()),
          actualReminderMeta: JSON.stringify(reminder.meta),
          scope:
            'Real local process/runner, owner renderer and manual deletion guard. No LLM response behavior or UI rendering is claimed.',
        },
        reviewQuestions: [
          'Do the start receipt, running reminder and deletion refusal agree with the actual PID, lifecycle and stdout/stderr facts, distinguish maintained state from manual notes, and explain an accurate response/maintenance boundary without conflicting instructions?',
        ],
        actualText: JSON.stringify(
          { receipt: handle.receipt, rendered, deleteRefusal: refused },
          null,
          2,
        ),
      });
    });
  }
  await evidence.write();
  console.log('Daemon daemon-reminder-render: PASS');
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
