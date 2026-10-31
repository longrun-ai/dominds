import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtCreateNewFileTool,
  teamMgmtOverwriteEntireFileTool,
  teamMgmtReadFileTool,
} from '../main/tools/team_mgmt';
import { padWriteTool, readFileTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-scoped-create-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const caller = new Team.Member({
      id: 'manager',
      name: 'Manager',
      toolsets: ['team_mgmt', 'ws_mod'],
    });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('manager');
      dlg.setLastUserLanguageCode(language);
      const file = `created-${language}.md`;
      const created = await teamMgmtCreateNewFileTool.call(dlg, caller, {
        path: file,
        content: '',
      });
      assert.equal(created.outcome, 'success');
      assert.equal(toolOutputData(created.content).path, `.minds/${file}`);
      assert.equal(await fs.readFile(`.minds/${file}`, 'utf8'), '');
      const read = await teamMgmtReadFileTool.call(dlg, caller, { path: `.minds/${file}` });
      assert.equal(read.outcome, 'success');
      assert.equal(toolOutputData(read.content).total_lines, 0);

      const payload = `pad-body-data-${language}-read_file-overwrite_entire_file`;
      const pad = await padWriteTool.call(dlg, caller, {
        pad_id: 'create_src',
        content: payload,
        intent: 'keep read_file as supplied metadata data',
        completion: 'after all required edits are accepted',
      });
      assert.equal(pad.outcome, 'success');
      assert.equal(pad.content.includes(payload), false);
      const padFile = `pad-created-${language}.md`;
      const fromPad = await teamMgmtCreateNewFileTool.call(dlg, caller, {
        path: padFile,
        pad_id: 'create_src',
      });
      assert.equal(fromPad.outcome, 'success');
      assert.equal(toolOutputData(fromPad.content).source, 'pad');
      assert.equal(fromPad.content.includes(payload), false);
      assert.equal(
        toolOutputData(fromPad.content).pad_intent,
        'keep read_file as supplied metadata data',
      );
      assert.equal(await fs.readFile(`.minds/${padFile}`, 'utf8'), `${payload}\n`);

      const replacement = `replacement-pad-data-${language}`;
      const writePad = await padWriteTool.call(dlg, caller, {
        pad_id: 'overwrite_src',
        content: replacement,
      });
      assert.equal(writePad.outcome, 'success');
      const beforeOverwrite = await teamMgmtReadFileTool.call(dlg, caller, { path: padFile });
      assert.equal(beforeOverwrite.outcome, 'success');
      const stats = toolOutputData(beforeOverwrite.content);
      const lines = stats.total_lines;
      const bytes = stats.size_bytes;
      assert.ok(typeof lines === 'number' && typeof bytes === 'number');
      const stale = await teamMgmtOverwriteEntireFileTool.call(dlg, caller, {
        path: padFile,
        known_old_total_lines: lines + 1,
        known_old_total_bytes: bytes,
        pad_id: 'overwrite_src',
      });
      assert.equal(stale.outcome, 'failure');
      assert.equal(toolOutputData(stale.content).error, 'STATS_MISMATCH');
      assert.equal(await fs.readFile(`.minds/${padFile}`, 'utf8'), `${payload}\n`);
      const missing = await teamMgmtOverwriteEntireFileTool.call(dlg, caller, {
        path: `missing-${language}.md`,
        known_old_total_lines: 0,
        known_old_total_bytes: 0,
        content: 'not-applied-data',
      });
      assert.equal(missing.outcome, 'failure');
      assert.equal(toolOutputData(missing.content).error, 'FILE_NOT_FOUND');
      await assert.rejects(fs.stat(`.minds/missing-${language}.md`), { code: 'ENOENT' });
      const overwritten = await teamMgmtOverwriteEntireFileTool.call(dlg, caller, {
        path: padFile,
        known_old_total_lines: lines,
        known_old_total_bytes: bytes,
        pad_id: 'overwrite_src',
      });
      assert.equal(overwritten.outcome, 'success');
      assert.equal(toolOutputData(overwritten.content).source, 'pad');
      assert.equal(overwritten.content.includes(replacement), false);
      assert.equal(await fs.readFile(`.minds/${padFile}`, 'utf8'), `${replacement}\n`);

      const existingBytes = `existing-data-${language}\n`;
      await fs.writeFile(`.minds/${file}`, existingBytes);
      const exists = await teamMgmtCreateNewFileTool.call(dlg, caller, {
        path: file,
        content: 'not-applied-data',
      });
      assert.equal(exists.outcome, 'failure');
      assert.equal(toolOutputData(exists.content).error, 'FILE_EXISTS');
      assert.equal(await fs.readFile(`.minds/${file}`, 'utf8'), existingBytes);
      const genericRead = await readFileTool.call(dlg, caller, { path: `.minds/${file}` });
      assert.equal(genericRead.outcome, 'failure');
      const scopedRead = await teamMgmtReadFileTool.call(dlg, caller, { path: file });
      assert.equal(scopedRead.outcome, 'success');
      assert.ok(
        scopedRead.content.includes(existingBytes.trim()),
        'the known original data is available through the scoped read',
      );
      const dir = `directory-${language}`;
      await fs.mkdir(`.minds/${dir}`);
      const notFile = await teamMgmtCreateNewFileTool.call(dlg, caller, {
        path: dir,
        content: 'not-applied-data',
      });
      assert.equal(notFile.outcome, 'failure');
      assert.equal(toolOutputData(notFile.content).error, 'NOT_A_FILE');
      assert.deepEqual(await fs.readdir(`.minds/${dir}`), []);
      const outside = `outside-${language}.md`;
      await fs.writeFile(outside, 'outside-original-data\n');
      const denied = await teamMgmtCreateNewFileTool.call(dlg, caller, {
        path: `../${outside}`,
        content: 'not-applied-data',
      });
      assert.equal(denied.outcome, 'failure');
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside-original-data\n');
      evidence.record({
        id: language,
        scenario:
          'Scoped creation refuses an existing .minds file and directory, preserves all bytes and rejects an escape path; the generic reader is denied while the team-scoped reader succeeds.',
        businessValue:
          'Give the team editor an applicable recovery path under the actual .minds capability boundary while preserving the intended new-file request.',
        context: {
          language,
          genericReadDenied: true,
          scopedReadSucceeded: true,
          existingFileUnchanged: true,
          directoryUnchanged: true,
          scopedReadTool: teamMgmtReadFileTool.name,
          scopedOverwriteTool: teamMgmtOverwriteEntireFileTool.name,
          scope:
            'Direct public tools, real disk and pad/dialog objects; not model or live reload coverage.',
        },
        reviewQuestions: [
          'Does the actual refusal/recovery text use tools that can operate on the scoped .minds path?',
          'Does it preserve the difference between creating a new file and intentionally replacing an existing file?',
          'Do success/refusal summaries describe only observed effects without claiming an outside write?',
        ],
        actualText: JSON.stringify(
          {
            existing: exists.content,
            stale: stale.content,
            missing: missing.content,
            directory: notFile.content,
            escape: denied.content,
            padCreation: fromPad.content,
            padOverwrite: overwritten.content,
          },
          null,
          2,
        ),
      });
    }
  });
  await evidence.write();
  console.log(
    'scoped create/overwrite, preserved refusals, path boundary and supplied pad metadata: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
