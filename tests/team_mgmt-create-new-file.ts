import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtCreateNewFileTool,
  teamMgmtOverwriteEntireFileTool,
  teamMgmtReadFileTool,
} from '../main/tools/team_mgmt';
import { padWriteTool } from '../main/tools/txt';

function countLogicalLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team_mgmt-create-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'team-mgmt-create.tsk',
      undefined,
      'tester',
    );
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    // Create empty file under .minds via shorthand path.
    const created = (
      await teamMgmtCreateNewFileTool.call(dlg, alice, {
        path: 'team.yaml',
        content: '',
      })
    ).content;
    assert.ok(created.includes('status: ok'));
    assert.ok(created.includes('mode: create_new_file'));
    assert.ok(created.includes("path: '.minds/team.yaml'"));

    const read = (await teamMgmtReadFileTool.call(dlg, alice, { path: 'team.yaml' })).content;
    assert.ok(read.includes('mode: read_file'));
    assert.ok(read.includes('total_lines: 0'));

    const padToken = 'TEAM_CREATE_PAD_TOKEN';
    const padWrite = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'team_create_src',
        content: padToken,
      })
    ).content;
    assert.ok(!padWrite.includes(padToken), 'pad_write should not echo pad body');
    const padCreated = (
      await teamMgmtCreateNewFileTool.call(dlg, alice, {
        path: 'pad-created.md',
        pad_id: 'team_create_src',
      })
    ).content;
    assert.ok(padCreated.includes('status: ok'));
    assert.ok(padCreated.includes('source: pad'));
    assert.ok(!padCreated.includes(padToken), 'team_mgmt_create_new_file should not echo pad body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'pad-created.md'), 'utf8'),
      `${padToken}\n`,
    );

    const overwritePadToken = 'TEAM_OVERWRITE_PAD_TOKEN';
    const overwritePadWrite = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'team_overwrite_src',
        content: overwritePadToken,
      })
    ).content;
    assert.ok(!overwritePadWrite.includes(overwritePadToken), 'pad_write should not echo pad body');
    const oldContent = await fs.readFile(path.join(tmpRoot, '.minds', 'pad-created.md'), 'utf8');
    const oldStat = await fs.stat(path.join(tmpRoot, '.minds', 'pad-created.md'));
    const padOverwrite = (
      await teamMgmtOverwriteEntireFileTool.call(dlg, alice, {
        path: 'pad-created.md',
        known_old_total_lines: countLogicalLines(oldContent),
        known_old_total_bytes: oldStat.size,
        pad_id: 'team_overwrite_src',
      })
    ).content;
    assert.ok(padOverwrite.includes('status: ok'));
    assert.ok(padOverwrite.includes('source: pad'));
    assert.ok(
      !padOverwrite.includes(overwritePadToken),
      'team_mgmt_overwrite_entire_file should not echo pad body',
    );
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'pad-created.md'), 'utf8'),
      `${overwritePadToken}\n`,
    );

    // Existing file should be refused.
    const exists = (
      await teamMgmtCreateNewFileTool.call(dlg, alice, {
        path: 'team.yaml',
        content: '',
      })
    ).content;
    assert.ok(exists.includes('status: error'));
    assert.ok(exists.includes('error: FILE_EXISTS'));

    // Existing directory path should be refused.
    await fs.mkdir(path.join(tmpRoot, '.minds', 'dir'), { recursive: true });
    const notAFile = (
      await teamMgmtCreateNewFileTool.call(dlg, alice, { path: 'dir', content: '' })
    ).content;
    assert.ok(notAFile.includes('status: error'));
    assert.ok(notAFile.includes('error: NOT_A_FILE'));

    console.log('✅ team_mgmt-create-new-file tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
