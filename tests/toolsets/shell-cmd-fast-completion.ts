import assert from 'node:assert/strict';
import { shellCmdTool } from '../../main/tools/os';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { shellDaemons, withShellDialog, writeNodeProgram } from '../helpers/shell-fixture';
const evidence = semanticEvidenceCollector('dominds-shell-completion-');
async function main() {
  for (const language of ['en', 'zh'] as const)
    await withShellDialog(language, async (dialog, caller) => {
      for (const [id, delayMs, timeoutSeconds] of [
        ['immediate', 0, 5],
        ['short-delayed', 250, 1],
      ] as const) {
        const payload = 'foreground-output-data-' + id + '-38b2';
        const command = await writeNodeProgram(
          'foreground-' + id,
          delayMs
            ? 'setTimeout(()=>console.log(' + JSON.stringify(payload) + '),250);'
            : 'console.log(' + JSON.stringify(payload) + ');',
        );
        const before = (await shellDaemons(dialog)).map((row) => row.id);
        const output = await shellCmdTool.call(dialog, caller, { command, timeoutSeconds });
        assert.equal(output.outcome, 'success');
        assert.ok(output.content.includes(payload)); // Complete given data, never notice meaning.
        assert.deepEqual(
          (await shellDaemons(dialog)).map((row) => row.id),
          before,
        );
        evidence.record({
          id: language + '-' + id,
          scenario:
            'A real child completes immediately or after its declared250ms work delay, within the original5s/1s foreground deadline. The handler returns the complete given stdout and creates no daemon reminder.',
          businessValue:
            'Preserve successful foreground completion instead of a false startup failure or unintended background transition.',
          context: {
            language,
            command,
            payload,
            declaredWorkDelayMs: delayMs,
            timeoutSeconds,
            actualDaemonIds: JSON.stringify(before),
            scope:
              'Real owned child/cmd_runner/tool/store; the250ms timer is fixture program work, not a test sleep. Two original work categories run once per language, not a race stress claim or timing benchmark.',
          },
          reviewQuestions: [
            'Does the actual completion receipt accurately describe the observed success and given output without a false background/failed-start claim?',
          ],
          actualText: output.content,
        });
      }
    });
  await evidence.write();
  console.log('Foreground completion and no unexpected daemon: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
