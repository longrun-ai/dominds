import assert from 'node:assert/strict';
import { materializeReminder } from '../../main/tool';
import { shellCmdReminderOwner } from '../../main/tools/os';
import {
  currentDaemon,
  jsonObject,
  processIsRunning,
  withDaemonFixture,
} from '../helpers/daemon-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { waitFor } from '../kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-daemon-daemon-exit-wake-event-');
async function main() {
  for (const language of ['en', 'zh'] as const) {
    await withDaemonFixture(language, async (fixture) => {
      const { root } = fixture;
      const handle = await fixture.start();
      const payload = 'exit-output-data:9c3f';
      await handle.send({ stdout: payload });
      await handle.waitOutput('stdout', payload);
      await root.processReminderUpdates();
      const before = await currentDaemon(root, handle.reminder.id);
      await handle.send({ exitCode: 7 });
      await waitFor(
        async () =>
          !(await processIsRunning(handle.meta.pid)) &&
          !(await processIsRunning(handle.meta.runnerPid)),
        3_000,
        'actual daemon and runner exit',
      );
      const wake = shellCmdReminderOwner.waitForReminderWakeEvent;
      assert.ok(wake);
      const observed = await wake(root, [before], new AbortController().signal);
      assert.ok(observed && 'eventId' in observed);
      const first = observed;
      assert.equal(first.reminderId, before.id);
      assert.equal(
        first.eventId,
        `shellCmd:daemonExited:${handle.meta.pid}:${handle.meta.startTime}`,
      );
      const meta = jsonObject(first.updatedMeta);
      assert.equal(meta.completed, true);
      assert.equal(meta.exitWakeEventId, first.eventId);
      assert.equal(typeof meta.exitWakeNotifiedAt, 'string');
      assert.equal(meta.originRootId, root.id.rootId);
      assert.equal(meta.originDialogId, root.id.selfId);
      assert.ok(first.updatedContent?.includes(payload));
      const delivered = materializeReminder({ ...before, content: first.updatedContent!, meta });
      assert.equal(await wake(root, [delivered], new AbortController().signal), null);
      const alreadyComplete = materializeReminder({
        ...before,
        meta: { ...jsonObject(before.meta), completed: true },
      });
      assert.equal(await wake(root, [alreadyComplete], new AbortController().signal), null);
      evidence.record({
        id: language + '-exit-wake',
        scenario:
          'A real owned daemon writes the supplied stdout data, its running snapshot is actually saved, and both child and runner exit after a declared code7 request. The OS observations prove exit, not its numeric code. The owner emits one exit event; feeding its completed/delivered state back produces no repeat.',
        businessValue:
          'Observe terminal state without duplicate continuation prompts or losing final output.',
        context: {
          language,
          pid: handle.meta.pid,
          startTime: handle.meta.startTime,
          observedDaemonRunning: await processIsRunning(handle.meta.pid),
          observedRunnerRunning: await processIsRunning(handle.meta.runnerPid),
          declaredExitCode: 7,
          payload,
          eventId: first.eventId,
          scope:
            'Real runner/owner component. Feeding returned event state back is explicit fixture acknowledgment, not backend delivery or agent execution.',
        },
        reviewQuestions: [
          'Does the actual exit notification and retained terminal snapshot accurately describe the observed exit and output, with appropriate maintenance/response guidance and no false claim that a follow-up action ran?',
        ],
        actualText: JSON.stringify(first, null, 2),
      });
    });
  }
  await evidence.write();
  console.log('Daemon daemon-exit-wake-event: PASS');
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
