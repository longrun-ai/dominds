import assert from 'node:assert/strict';
import { shellCmdTool } from '../../main/tools/os';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withShellDialog, writeNodeProgram } from '../helpers/shell-fixture';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-shell-truncation-');
  for (const language of ['en', 'zh'] as const) {
    await withShellDialog(language, async (dialog, caller) => {
      const rows = Array.from(
        { length: 200 },
        (_, index) => 'row-' + String(index + 1).padStart(6, '0') + ' ' + 'x'.repeat(600) + '\n',
      );
      const source = rows.join('');
      const command = await writeNodeProgram(
        'truncated-output',
        'process.stdout.write(' + JSON.stringify(source) + ');',
      );
      const result = await shellCmdTool.call(dialog, caller, { command, timeoutSeconds: 5 });
      assert.equal(result.outcome, 'success');
      assert.ok(result.content.includes(rows[0]!));
      assert.ok(result.content.includes(rows[199]!));
      assert.ok(!result.content.includes(rows[99]!));
      // Documented machine marker and numeric fields; no receipt wording is an oracle.
      const markers = [
        ...result.content.matchAll(
          /\[tool_output_truncated_in_tool tool=shell_cmd_stdout original_chars=(\d+) limit_chars=(\d+) omitted_chars=(\d+)\]/g,
        ),
      ];
      assert.equal(markers.length, 1);
      const marker = markers[0]!;
      assert.equal(Number(marker[1]), source.length);
      assert.equal(Number(marker[2]), 48_000);
      assert.ok(Number(marker[3]) > 0 && Number(marker[3]) < source.length);
      assert.ok(result.content.length <= 60_000);
      evidence.record({
        id: 'shell-truncation-' + language,
        scenario:
          'A completed foreground command emits 200 given rows; both ends survive a bounded receipt.',
        businessValue:
          'An executing agent sees completion and knows output was omitted without losing the useful ends.',
        context: {
          language,
          command,
          originalChars: source.length,
          firstRow: rows[0]!,
          lastRow: rows[199]!,
          omittedMiddleRow: rows[99]!,
          scope:
            'Real process/stdout and tool receipt; character bound only, no peak-memory benchmark.',
        },
        reviewQuestions: [
          'Does the actual receipt describe a successful completed command and visibly explain truncation without suggesting a daemon or complete output?',
        ],
        actualText: result.content,
      });
      const shortData = 'short-output-data:9c71';
      const shortCommand = await writeNodeProgram(
        'short-output',
        'console.log(' + JSON.stringify(shortData) + ');',
      );
      const short = await shellCmdTool.call(dialog, caller, {
        command: shortCommand,
        timeoutSeconds: 5,
      });
      assert.equal(short.outcome, 'success');
      assert.ok(short.content.includes(shortData));
      assert.ok(!short.content.includes('[tool_output_truncated_in_tool '));
    });
  }
  await evidence.write();
  console.log('Foreground output data, omission metadata and bounds: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
