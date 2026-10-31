import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeReminder } from '../../main/tool';
import { resetTrackedDaemonsForTests, shellCmdReminderOwner } from '../../main/tools/os';
import { processIsRunning, withDaemonFixture } from '../helpers/daemon-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-daemon-legacy-');
const execFileAsync = promisify(execFile);
async function commandLine(pid: number) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`,
    ]);
    return stdout.trim();
  }
  return (await execFileAsync('ps', ['-p', String(pid), '-o', 'args='])).stdout.trim();
}
async function main() {
  for (const language of ['en', 'zh'] as const)
    await withDaemonFixture(language, async ({ rtws, root }) => {
      const wrapper = path.join(rtws, `legacy-pnpm-${language}.cjs`);
      await fs.writeFile(wrapper, "process.send({ready:true}); process.on('message',()=>{});\n");
      const startedAt = new Date();
      const child = spawn(process.execPath, [wrapper, 'dev'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: process.platform !== 'win32',
      });
      const closed = once(child, 'exit');
      try {
        assert.deepEqual((await once(child, 'message'))[0], { ready: true });
        const pid = child.pid;
        assert.ok(typeof pid === 'number');
        assert.equal(await processIsRunning(pid), true);
        const actualCommandLine = await commandLine(pid);
        assert.ok(actualCommandLine.length > 0);
        const reminder = materializeReminder({
          id: 'legacy-wrapper-' + language,
          content: 'legacy-wrapper-state-data:7a4f',
          owner: shellCmdReminderOwner,
          scope: 'runtime',
          renderMode: 'markdown',
          meta: {
            kind: 'daemon',
            pid,
            initialCommandLine: 'pnpm dev',
            daemonCommandLine: actualCommandLine,
            shell: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            startTime: formatUnifiedTimestamp(startedAt),
            ...(process.platform === 'win32' ? {} : { processGroupId: pid }),
          },
        });
        resetTrackedDaemonsForTests();
        const update = await shellCmdReminderOwner.updateReminder(root, reminder);
        assert.equal(update.treatment, 'drop');
        await closed;
        assert.equal(await processIsRunning(pid), false);
        const rendered = await shellCmdReminderOwner.renderReminder(root, reminder);
        assert.equal(rendered.type, 'environment_msg');
        assert.equal(rendered.role, 'user');
        evidence.record({
          id: language + '-legacy-wrapper-cleanup',
          scenario:
            'An owned real Node wrapper is ready and running. A legacy reminder has the actual PID/command/start identity but no runner metadata. The owner cleans up the matched stale process and drops that legacy record.',
          businessValue:
            'Handle pre-runner records without pretending they provide a recoverable live output channel or leaving an abandoned matching process running.',
          context: {
            language,
            pid,
            actualCommandLine,
            givenLegacyMeta: JSON.stringify(reminder.meta),
            observedProcessRunningAfterUpdate: false,
            scope:
              'Real owned Node wrapper and OS process inspection/termination; a pnpm-like fixture filename, not an actual pnpm dev service or successful daemon recovery.',
          },
          reviewQuestions: [
            'Does the actual rendered terminal notice accurately describe the now-stopped legacy process without claiming recovered monitoring or an unperformed action?',
          ],
          actualText: JSON.stringify({ update, rendered }, null, 2),
        });
      } finally {
        if (child.pid && (await processIsRunning(child.pid))) child.kill('SIGTERM');
        await closed;
      }
    });
  await evidence.write();
  console.log('Legacy wrapper identity cleanup: PASS');
}
const watchdog = setTimeout(() => {
  throw new Error('Legacy wrapper case did not complete within60 seconds');
}, 60_000);
main().then(
  () => clearTimeout(watchdog),
  (error: unknown) => {
    clearTimeout(watchdog);
    console.error(error);
    process.exitCode = 1;
  },
);
