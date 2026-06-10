import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { teamMgmtFileRangeEditTool, teamMgmtTools } from '../main/tools/team_mgmt';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team_mgmt-range-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'one\ntwo\nthree\n', 'utf8');

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const toolNames = new Set(teamMgmtTools.map((tool) => tool.name));
    assert.ok(toolNames.has('team_mgmt_file_range_edit'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_range_edit'));

    const token = 'TEAM_MGMT_RANGE_TOKEN';
    const output = (
      await teamMgmtFileRangeEditTool.call(dlg, alice, {
        path: 'team.yaml',
        range: '2~2',
        content: `${token}\n`,
      })
    ).content;
    assert.ok(output.includes('mode: file_range_edit'));
    assert.ok(output.includes("path: '.minds/team.yaml'"));
    assert.ok(!output.includes(token), 'team_mgmt_file_range_edit should not echo body by default');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `one\n${token}\nthree\n`,
    );

    const previewOutput = (
      await teamMgmtFileRangeEditTool.call(dlg, alice, {
        path: 'team.yaml',
        range: '2~2',
        content: 'PREVIEW_ONLY\n',
        preview: true,
        show_diff: true,
      })
    ).content;
    assert.ok(previewOutput.includes('preview: true'));
    assert.ok(previewOutput.includes('```diff'));
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `one\n${token}\nthree\n`,
      'preview must not write the file',
    );

    console.log('✅ team_mgmt-file-range-edit tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
