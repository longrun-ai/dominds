import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Team } from '../../main/team';
import { listDirTool } from '../../main/tools/fs';
import { withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-directory-listing-');
  for (const language of ['en', 'zh'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const caller = new Team.Member({ id: 'tester', name: 'Tester', read_dirs: ['**'] });
      const directory = 'listing-data-' + language;
      await fs.mkdir(directory);
      const names = Array.from(
        { length: 400 },
        (_, index) => 'entry-' + String(index + 1).padStart(4, '0') + '-' + 'x'.repeat(80) + '.txt',
      );
      for (const [index, name] of names.entries())
        await fs.writeFile(directory + '/' + name, 'line-' + (index + 1) + '\n');
      const before = (await fs.readdir(directory)).sort();
      assert.deepEqual(before, names);
      const result = await listDirTool.call(dialog, caller, { path: directory });
      assert.equal(result.outcome, 'success');
      // These are complete supplied file names, not generated omission/header prose.
      const shownNames = names.filter((name) => result.content.includes(name));
      assert.equal(shownNames.length, 120);
      assert.ok(result.content.length <= 60_000);
      assert.deepEqual((await fs.readdir(directory)).sort(), before);
      assert.equal(await fs.readFile(directory + '/' + names[399], 'utf8'), 'line-400\n');
      evidence.record({
        id: 'directory-bounded-' + language,
        scenario:
          'A real directory contains 400 given long filenames and returns 120 of them without mutating the directory.',
        businessValue:
          'An agent sees a useful bounded listing and understands that remaining entries exist.',
        context: {
          language,
          directory,
          suppliedEntries: 400,
          actualGivenNamesShown: 120,
          omittedEntries: 280,
          firstGivenName: names[0]!,
          shownExample: shownNames[0]!,
          omittedExample: names.find((name) => !shownNames.includes(name))!,
          scope:
            'Actual isolated filesystem/native dialog/tool; character bound, not a memory or large-directory performance benchmark.',
        },
        reviewQuestions: [
          'Does the actual complete listing accurately explain its partial scope and omission count without claiming the directory has only the shown entries?',
        ],
        actualText: result.content,
      });
      const small = 'small-listing-data-' + language;
      await fs.mkdir(small);
      await fs.writeFile(small + '/single-data.txt', 'given single file data');
      const complete = await listDirTool.call(dialog, caller, { path: small });
      assert.equal(complete.outcome, 'success');
      assert.ok(complete.content.includes('single-data.txt'));
      evidence.record({
        id: 'directory-complete-' + language,
        scenario: 'A real directory has one supplied file and the actual listing returns it.',
        businessValue:
          'A small complete listing must remain distinguishable from an incomplete bounded result.',
        context: {
          language,
          directory: small,
          suppliedEntries: 1,
          givenName: 'single-data.txt',
          scope: 'Actual local listing only; no browser rendering.',
        },
        reviewQuestions: [
          'Does the actual listing present the complete supplied one-file directory without an invented omission?',
        ],
        actualText: complete.content,
      });
    });
  }
  await evidence.write();
  console.log('Actual directory rows, non-mutation and bounded output: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
