import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/shared/runtime-language';
import { Team } from '../main/team';
import { teamMgmtCreateNewFileTool, teamMgmtReadFileTool } from '../main/tools/team-mgmt';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-create-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    // Create empty file under .minds via shorthand path.
    const created = await teamMgmtCreateNewFileTool.call(dlg, alice, {
      path: 'team.yaml',
      content: '',
    });
    assert.ok(created.includes('status: ok'));
    assert.ok(created.includes('mode: create_new_file'));
    assert.ok(created.includes("path: '.minds/team.yaml'"));

    const read = await teamMgmtReadFileTool.call(dlg, alice, { path: 'team.yaml' });
    assert.ok(read.includes('mode: read_file'));
    assert.ok(read.includes('total_lines: 0'));

    // Existing file should be refused.
    const exists = await teamMgmtCreateNewFileTool.call(dlg, alice, {
      path: 'team.yaml',
      content: '',
    });
    assert.ok(exists.includes('status: error'));
    assert.ok(exists.includes('error: FILE_EXISTS'));

    // Existing directory path should be refused.
    await fs.mkdir(path.join(tmpRoot, '.minds', 'dir'), { recursive: true });
    const notAFile = await teamMgmtCreateNewFileTool.call(dlg, alice, { path: 'dir', content: '' });
    assert.ok(notAFile.includes('status: error'));
    assert.ok(notAFile.includes('error: NOT_A_FILE'));

    console.log('✅ team-mgmt-create-new-file tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
