import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { createNewFileTool, padWriteTool, readFileTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-create-file-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const caller = new Team.Member({ id: 'editor', name: 'Editor' });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('editor');
      const file = `created-${language}.txt`;
      const empty = await createNewFileTool.call(dlg, caller, { path: file, content: '' });
      assert.equal(empty.outcome, 'success');
      const emptyData = toolOutputData(empty.content);
      assert.equal(emptyData.mode, 'create_new_file');
      assert.equal(emptyData.new_total_lines, 0);
      assert.equal(emptyData.new_total_bytes, 0);
      assert.equal(await fs.readFile(file, 'utf8'), '');
      const readEmpty = await readFileTool.call(dlg, caller, { path: file });
      assert.equal(readEmpty.outcome, 'success');
      assert.equal(toolOutputData(readEmpty.content).total_lines, 0);

      const original = `existing-file-data-${language}\n`;
      await fs.writeFile(file, original);
      const exists = await createNewFileTool.call(dlg, caller, {
        path: file,
        content: 'replacement-data',
      });
      assert.equal(exists.outcome, 'failure');
      assert.equal(toolOutputData(exists.content).error, 'FILE_EXISTS');
      assert.equal(
        await fs.readFile(file, 'utf8'),
        original,
        'refused creation must preserve existing bytes',
      );

      const directory = `existing-directory-${language}`;
      await fs.mkdir(directory);
      const notFile = await createNewFileTool.call(dlg, caller, {
        path: directory,
        content: 'replacement-data',
      });
      assert.equal(notFile.outcome, 'failure');
      assert.equal(toolOutputData(notFile.content).error, 'NOT_A_FILE');
      assert.ok((await fs.stat(directory)).isDirectory());
      assert.deepEqual(await fs.readdir(directory), []);

      const normalizedFile = `normalized-${language}.txt`;
      const normalized = await createNewFileTool.call(dlg, caller, {
        path: normalizedFile,
        content: 'body-data',
      });
      assert.equal(normalized.outcome, 'success');
      assert.equal(toolOutputData(normalized.content).normalized_trailing_newline_added, true);
      assert.equal(await fs.readFile(normalizedFile, 'utf8'), 'body-data\n');

      const token = `private-pad-body-data-${language}`;
      const pad = await padWriteTool.call(dlg, caller, {
        pad_id: 'create_src',
        content: `${token}\n`,
      });
      assert.equal(pad.outcome, 'success');
      assert.equal(pad.content.includes(token), false, 'the supplied private body is not echoed');
      const padFile = `from-pad-${language}.txt`;
      const created = await createNewFileTool.call(dlg, caller, {
        path: padFile,
        pad_id: 'create_src',
      });
      assert.equal(created.outcome, 'success');
      const data = toolOutputData(created.content);
      assert.equal(data.source, 'pad');
      assert.equal(data.redacted, true);
      assert.equal(created.content.includes(token), false);
      assert.equal(await fs.readFile(padFile, 'utf8'), `${token}\n`);

      const other = await createMainDialog('editor');
      const unavailable = await createNewFileTool.call(other, caller, {
        path: `other-dialog-${language}.txt`,
        pad_id: 'create_src',
      });
      assert.equal(unavailable.outcome, 'failure');
      await assert.rejects(fs.lstat(`other-dialog-${language}.txt`), { code: 'ENOENT' });
      assert.equal(unavailable.content.includes(token), false);

      evidence.record({
        id: language,
        scenario:
          'Create-new-file refuses an existing file and a directory; an owning dialog creates from its pad while another dialog cannot use that pad.',
        businessValue:
          'Preserve existing work, give an accurate safe next step after refusal, and keep private editing input out of unrelated output.',
        context: {
          language,
          existingFileUnchanged: true,
          directoryUnchanged: true,
          owningPadFileHasExactBody: true,
          otherDialogHasNoPad: true,
          scope:
            'Direct public tools, real disk and dialog/reminder objects; not provider behavior or restart persistence.',
        },
        reviewQuestions: [
          'Does the actual refusal/recovery guidance explain the observed state and a safe applicable next action?',
          'Do the pad success and unavailable-pad diagnostics avoid claiming nonexistent writes or revealing the supplied private body?',
        ],
        actualText: JSON.stringify(
          {
            existingFile: exists.content,
            directory: notFile.content,
            createdFromPad: created.content,
            unavailablePad: unavailable.content,
          },
          null,
          2,
        ),
      });
    }
  });
  await evidence.write();
  console.log(
    'create-new-file preserves existing data, normalizes new data and scopes pad sources: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
