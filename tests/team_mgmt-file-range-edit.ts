import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtFileAppendTool,
  teamMgmtFileRangeEditTool,
  teamMgmtTools,
} from '../main/tools/team_mgmt';
import { padWriteTool } from '../main/tools/txt';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team_mgmt-range-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'one\ntwo\nthree\n', 'utf8');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'team-mgmt-range.tsk',
      undefined,
      'tester',
    );
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const toolNames = new Set(teamMgmtTools.map((tool) => tool.name));
    assert.ok(toolNames.has('team_mgmt_file_range_edit'));
    assert.ok(toolNames.has('team_mgmt_file_append'));
    assert.ok(toolNames.has('team_mgmt_file_insert_after'));
    assert.ok(toolNames.has('team_mgmt_file_insert_before'));
    assert.ok(toolNames.has('team_mgmt_file_block_replace'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_range_edit'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_append'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_insert_after'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_insert_before'));
    assert.ok(!toolNames.has('team_mgmt_prepare_file_block_replace'));

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

    const padToken = 'TEAM_MGMT_PAD_RANGE_TOKEN';
    const padWriteOutput = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'team_range_src',
        content: `${padToken}\n`,
      })
    ).content;
    assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');
    const padRangeOutput = (
      await teamMgmtFileRangeEditTool.call(dlg, alice, {
        path: 'team.yaml',
        range: '3~3',
        pad_id: 'team_range_src',
      })
    ).content;
    assert.ok(padRangeOutput.includes('source: pad'));
    assert.ok(!padRangeOutput.includes(padToken), 'team_mgmt pad range edit should not echo body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `one\n${token}\n${padToken}\n`,
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
      `one\n${token}\n${padToken}\n`,
      'preview must not write the file',
    );

    const appendToken = 'TEAM_MGMT_APPEND_TOKEN';
    const appendOutput = (
      await teamMgmtFileAppendTool.call(dlg, alice, {
        path: 'team.yaml',
        content: `${appendToken}\n`,
      })
    ).content;
    assert.ok(appendOutput.includes('mode: file_append'));
    assert.ok(!appendOutput.includes(appendToken), 'team_mgmt_file_append should not echo body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `one\n${token}\n${padToken}\n${appendToken}\n`,
    );

    console.log('✅ team_mgmt-file-range-edit tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
