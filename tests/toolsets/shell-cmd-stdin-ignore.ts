import assert from 'node:assert/strict';
import { shellCmdTool } from '../../main/tools/os';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  fixtureJson,
  shellDaemons,
  withShellDialog,
  writeNodeProgram,
} from '../helpers/shell-fixture';
const evidence = semanticEvidenceCollector('dominds-shell-stdin-');
async function main() {
  for (const language of ['en', 'zh'] as const)
    await withShellDialog(language, async (dialog, caller) => {
      const probe = 'stdin-probe-data:2c91';
      const source = [
        "let data='';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data',chunk=>{data+=chunk;});",
        "process.stdin.on('end',()=>console.log(JSON.stringify({probe:" +
          JSON.stringify(probe) +
          ',ended:true,length:data.length})));',
        'process.stdin.resume();',
      ].join('\n');
      const command = await writeNodeProgram('stdin-probe', source);
      const before = (await shellDaemons(dialog)).map((row) => row.id);
      const output = await shellCmdTool.call(dialog, caller, { command, timeoutSeconds: 5 });
      assert.equal(output.outcome, 'success');
      assert.deepEqual(fixtureJson(output.content, probe), { probe, ended: true, length: 0 });
      assert.deepEqual(
        (await shellDaemons(dialog)).map((row) => row.id),
        before,
      );
      evidence.record({
        id: language + '-stdin-eof',
        scenario:
          'A real child listens to stdin, observes end-of-stream with zero characters, prints that fixture data and exits within the original5s deadline without a daemon record.',
        businessValue:
          'Keep a noninteractive tool command from waiting forever for user input or leaking into background execution.',
        context: {
          language,
          command,
          probe,
          actualChildData: JSON.stringify(fixtureJson(output.content, probe)),
          scope:
            'Real owned process/runner/tool and public reminder state. This proves EOF/no input for this command, not terminal interaction or an arbitrary application protocol.',
        },
        reviewQuestions: [
          'Does the actual receipt faithfully present the given child report and completion without suggesting input was supplied or a daemon was started?',
        ],
        actualText: output.content,
      });
    });
  await evidence.write();
  console.log('Shell stdin EOF without daemonizing: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
