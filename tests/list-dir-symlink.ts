import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { listDirTool } from '../main/tools/fs';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-list-dir-symlink-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('zh');

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const targetDir = path.join(tmpRoot, 'actual-shared');
    const linkDir = path.join(tmpRoot, 'dominds', 'webapp', 'src', 'shared');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.dirname(linkDir), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'marker.txt'), 'line-1\nline-2\n', 'utf-8');
    await fs.symlink(targetDir, linkDir);

    const output = (
      await listDirTool.call(dlg, alice, {
        path: 'dominds/webapp/src/shared',
      })
    ).content;

    assert.ok(output.includes('📁 **目录：**'), 'should render directory header');
    assert.ok(!output.includes('不是目录'), 'should not reject symlink dir as not-a-directory');
    assert.ok(output.includes('是符号链接'), 'should include symlink-follow note');
    assert.ok(output.includes('`marker.txt`'), 'should list content from target directory');

    console.log('✅ list-dir-symlink tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
