import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { ToolArguments } from '../../main/tool';
import { getDaemonOutputTool } from '../../main/tools/os';
import { withDaemonFixture } from '../helpers/daemon-reminders';
import { observeRunner } from '../helpers/daemon-runner-observer';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-daemon-output-');
async function main() {
  for (const language of ['en', 'zh'] as const)
    await withDaemonFixture(language, async (fixture) => {
      const { root, caller } = fixture;
      const handle = await fixture.start();
      const stdout = 'selected-stdout-data:7a2e';
      const stderr = 'selected-stderr-data:49c1';
      await handle.send({ stdout, stderr });
      await handle.waitOutput('stdout', stdout);
      await handle.waitOutput('stderr', stderr);
      const both = await getDaemonOutputTool.call(root, caller, { pid: handle.meta.pid });
      const onlyStdout = await getDaemonOutputTool.call(root, caller, {
        pid: handle.meta.pid,
        stdout: true,
        stderr: false,
      });
      const onlyStderr = await getDaemonOutputTool.call(root, caller, {
        pid: handle.meta.pid,
        stdout: false,
        stderr: true,
      });
      for (const output of [both, onlyStdout, onlyStderr]) assert.equal(output.outcome, 'success');
      assert.ok(both.content.includes(stdout) && both.content.includes(stderr));
      assert.ok(onlyStdout.content.includes(stdout) && !onlyStdout.content.includes(stderr));
      assert.ok(onlyStderr.content.includes(stderr) && !onlyStderr.content.includes(stdout));
      const rejections = [];
      const invalidInputs: ToolArguments[] = [
        { pid: handle.meta.pid, stdout: false, stderr: false },
        { pid: handle.meta.pid, wait_for_new_output: false, timeout_ms: 100 },
        { pid: handle.meta.pid, timeout_ms: 86_400_001 },
      ];
      for (const input of invalidInputs) {
        let failure: unknown;
        try {
          await getDaemonOutputTool.call(root, caller, input);
        } catch (error) {
          failure = error;
        }
        assert.ok(failure instanceof Error);
        rejections.push({ input, error: failure.message });
      }
      evidence.record({
        id: language + '-selected-output-refusals',
        scenario:
          'A real owned daemon produced distinct supplied stdout and stderr. Public tool calls select both or either stream, then three invalid argument combinations are rejected.',
        businessValue:
          'Deliver only requested data and explain invalid waiting/stream selection without implying an action succeeded.',
        context: {
          language,
          stdout,
          stderr,
          actualStatus: JSON.stringify(await handle.status()),
          scope:
            'Actual local child, runner IPC and public tool parser. Given opaque child payloads are data, not generated meaning.',
        },
        reviewQuestions: [
          'Do the actual headings/stream selection and argument diagnostics accurately explain the observed data and refused combinations without mixing streams or promising an unperformed action?',
        ],
        actualText: JSON.stringify({ both, onlyStdout, onlyStderr, rejections }, null, 2),
      });

      const observer = await observeRunner(handle.meta.runnerEndpoint);
      const original = JSON.parse(await fs.readFile(handle.sharedPath, 'utf8'));
      const redirected = structuredClone(original);
      redirected.meta.runnerEndpoint = observer.endpoint;
      await fs.writeFile(handle.sharedPath, JSON.stringify(redirected) + '\n');
      try {
        // No new selected-stream output: actual timeout status is observed at the real
        // runner boundary; no natural-language timeout phrase is an oracle.
        let observed = observer.nextWait();
        const started = performance.now();
        let outputPromise = getDaemonOutputTool.call(root, caller, {
          pid: handle.meta.pid,
          stdout: false,
          stderr: true,
          wait_for_new_output: true,
          timeout_ms: 100,
        });
        let observation = await observed;
        assert.deepEqual(observation.request, {
          type: 'get_output',
          stdout: false,
          stderr: true,
          waitForNewOutput: true,
          timeoutMs: 100,
        });
        let output = await outputPromise;
        let actual = await observation.response;
        assert.ok(actual.ok && actual.type === 'output');
        assert.equal(actual.waitStatus, 'timeout');
        assert.ok(performance.now() - started >= 100);
        assert.ok(!output.content.includes(stdout));
        evidence.record({
          id: language + '-selected-empty-timeout',
          scenario:
            'The stderr buffer is unchanged. A real public wait for new stderr uses timeout100ms and the actual runner returns timeout.',
          businessValue:
            'Preserve bounded waiting on the requested stream rather than treating existing output or a different stream as a new event.',
          context: {
            language,
            actualRequest: JSON.stringify(observation.request),
            actualResponse: JSON.stringify(actual),
            scope:
              'Transparent owned IPC observer forwards the exact public tool request and real runner reply. No synthetic response or installed-waiter claim.',
          },
          reviewQuestions: [
            'Does the actual tool output accurately report the timeout and requested stderr snapshot without implying new stdout/stderr was received?',
          ],
          actualText: output.content,
        });

        // The request observation is not a waiter-installed acknowledgment. Start
        // an ongoing controlled child stream, so genuine changes continue after
        // the actual runner installs its waiter, without a test-side sleep.
        observed = observer.nextWait();
        outputPromise = getDaemonOutputTool.call(root, caller, {
          pid: handle.meta.pid,
          stdout: true,
          stderr: false,
          wait_for_new_output: true,
          timeout_ms: 8000,
        });
        observation = await observed;
        assert.deepEqual(observation.request, {
          type: 'get_output',
          stdout: true,
          stderr: false,
          waitForNewOutput: true,
          timeoutMs: 8000,
        });
        const newStdout = 'new-waited-stdout-data:51ae';
        await handle.send({ stdout: newStdout, repeat: true });
        output = await outputPromise;
        actual = await observation.response;
        await handle.send({ stopRepeat: true });
        assert.ok(actual.ok && actual.type === 'output');
        assert.equal(actual.waitStatus, 'output');
        assert.ok(output.content.includes(newStdout));
        assert.ok(!output.content.includes(stderr));
        evidence.record({
          id: language + '-selected-new-output',
          scenario:
            'After the public wait request is observed, a controlled real child starts an ongoing stdout stream. The actual runner resolves the requested-stream wait with output and the tool returns the new supplied data.',
          businessValue: 'Resume monitoring on actual requested data instead of a timed guess.',
          context: {
            language,
            newStdout,
            excludedStderr: stderr,
            actualRequest: JSON.stringify(observation.request),
            actualResponse: JSON.stringify(actual),
            scope:
              'Real tool/runner/child through a transparent IPC observer. Observation is request forwarding, not proof of the exact waiter installation instant.',
          },
          reviewQuestions: [
            'Does the returned text accurately represent the requested new stdout data and avoid mixing the excluded stderr or falsely reporting timeout/exit?',
          ],
          actualText: output.content,
        });

        observed = observer.nextWait();
        const unrelatedWaitStarted = performance.now();
        outputPromise = getDaemonOutputTool.call(root, caller, {
          pid: handle.meta.pid,
          stdout: false,
          stderr: true,
          wait_for_new_output: true,
          timeout_ms: 1200,
        });
        observation = await observed;
        assert.deepEqual(observation.request, {
          type: 'get_output',
          stdout: false,
          stderr: true,
          waitForNewOutput: true,
          timeoutMs: 1200,
        });
        const unrelated = 'unrequested-stdout-data:8c4d';
        await handle.send({ stdout: unrelated, repeat: true });
        await handle.waitOutput('stdout', unrelated);
        output = await outputPromise;
        const unrelatedWaitElapsedMs = performance.now() - unrelatedWaitStarted;
        assert.ok(unrelatedWaitElapsedMs >= 1000);
        actual = await observation.response;
        await handle.send({ stopRepeat: true });
        assert.ok(actual.ok && actual.type === 'output');
        assert.equal(actual.waitStatus, 'timeout');
        assert.ok(!output.content.includes(unrelated));
        assert.ok(!output.content.includes(stdout));
        evidence.record({
          id: language + '-unrequested-output-timeout',
          scenario:
            'While the public request waits for new stderr, the controlled real child continuously writes only stdout. The runner still returns timeout for stderr and the adapter excludes stdout.',
          businessValue:
            'Keep an unrelated noisy stream from prematurely satisfying a requested-stream wait.',
          context: {
            language,
            actualRequest: JSON.stringify(observation.request),
            actualResponse: JSON.stringify(actual),
            unrelatedWaitElapsedMs,
            actualChildStdoutWitness: JSON.stringify((await handle.status()).stdout),
            unrelated,
            scope:
              'Actual real runner wait status and controlled ongoing stdout. No arbitrary test sleep or natural-language timeout oracle.',
          },
          reviewQuestions: [
            'Does the actual output clearly describe the stderr timeout and its retained snapshot without presenting unrelated stdout as new requested output?',
          ],
          actualText: output.content,
        });
      } finally {
        await fs.writeFile(handle.sharedPath, JSON.stringify(original) + '\n');
        await observer.close();
      }
    });
  await evidence.write();
  console.log('Daemon selected output and real waiting: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Daemon stream case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
