import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/shared/runtime-language';
import { Team } from '../main/team';
import { mkDirTool, moveDirTool, moveFileTool, rmDirTool, rmFileTool } from '../main/tools/fs';

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-fs-symlink-follow-'));
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

    // rm_file: symlink -> file
    const fileTarget = path.join(tmpRoot, 'file-target.txt');
    const fileLink = path.join(tmpRoot, 'file-link.txt');
    await fs.writeFile(fileTarget, 'hello\n', 'utf8');
    await fs.symlink(fileTarget, fileLink);
    const rmFileOut = await rmFileTool.call(dlg, alice, { path: 'file-link.txt' });
    assert.ok(rmFileOut.includes('已删除文件'), 'rm_file should succeed on symlink to file');
    assert.ok(rmFileOut.includes('符号链接'), 'rm_file should explain symlink follow');
    assert.equal(await exists(fileLink), false, 'rm_file should remove link path');
    assert.equal(await exists(fileTarget), true, 'rm_file should keep target file');

    // rm_dir: symlink -> empty dir
    const dirTarget = path.join(tmpRoot, 'dir-target');
    const dirLink = path.join(tmpRoot, 'dir-link');
    await fs.mkdir(dirTarget, { recursive: true });
    await fs.symlink(dirTarget, dirLink);
    const rmDirOut = await rmDirTool.call(dlg, alice, { path: 'dir-link', recursive: false });
    assert.ok(rmDirOut.includes('已删除目录'), 'rm_dir should succeed on symlink to dir');
    assert.ok(rmDirOut.includes('符号链接'), 'rm_dir should explain symlink follow');
    assert.equal(await exists(dirLink), false, 'rm_dir should remove link path');
    assert.equal(await exists(dirTarget), true, 'rm_dir should keep target dir');

    // mk_dir: existing symlink -> dir
    const mkTarget = path.join(tmpRoot, 'mk-target');
    const mkLink = path.join(tmpRoot, 'mk-link');
    await fs.mkdir(mkTarget, { recursive: true });
    await fs.symlink(mkTarget, mkLink);
    const mkOut = await mkDirTool.call(dlg, alice, { path: 'mk-link' });
    assert.ok(mkOut.includes('status: ok'), 'mk_dir should treat symlinked dir as existing dir');
    assert.ok(mkOut.includes('created: false'));
    assert.ok(mkOut.includes('path_kind: symlink'), 'mk_dir should annotate symlink path');

    // move_file: from symlink file, to parent symlink dir
    const moveFileTarget = path.join(tmpRoot, 'move-file-target.txt');
    const moveFileLink = path.join(tmpRoot, 'move-file-link.txt');
    await fs.writeFile(moveFileTarget, 'move me\n', 'utf8');
    await fs.symlink(moveFileTarget, moveFileLink);
    const moveFileDstParentReal = path.join(tmpRoot, 'move-file-dst-real');
    const moveFileDstParentLink = path.join(tmpRoot, 'move-file-dst-link');
    await fs.mkdir(moveFileDstParentReal, { recursive: true });
    await fs.symlink(moveFileDstParentReal, moveFileDstParentLink);
    const moveFileOut = await moveFileTool.call(dlg, alice, {
      from: 'move-file-link.txt',
      to: 'move-file-dst-link/moved-link.txt',
    });
    assert.ok(moveFileOut.includes('status: ok'), 'move_file should succeed with symlink from/parent');
    assert.ok(moveFileOut.includes('from_path_kind: symlink'));
    assert.ok(moveFileOut.includes('to_parent_path_kind: symlink'));
    assert.equal(await exists(path.join(moveFileDstParentReal, 'moved-link.txt')), true);
    assert.equal(await exists(moveFileTarget), true, 'moving symlink path should keep target file');

    // move_dir: from symlink dir, to parent symlink dir
    const moveDirTarget = path.join(tmpRoot, 'move-dir-target');
    const moveDirLink = path.join(tmpRoot, 'move-dir-link');
    await fs.mkdir(path.join(moveDirTarget, 'sub'), { recursive: true });
    await fs.writeFile(path.join(moveDirTarget, 'sub', 'a.txt'), 'a\n', 'utf8');
    await fs.symlink(moveDirTarget, moveDirLink);
    const moveDirDstParentReal = path.join(tmpRoot, 'move-dir-dst-real');
    const moveDirDstParentLink = path.join(tmpRoot, 'move-dir-dst-link');
    await fs.mkdir(moveDirDstParentReal, { recursive: true });
    await fs.symlink(moveDirDstParentReal, moveDirDstParentLink);
    const moveDirOut = await moveDirTool.call(dlg, alice, {
      from: 'move-dir-link',
      to: 'move-dir-dst-link/moved-dir-link',
    });
    assert.ok(moveDirOut.includes('status: ok'), 'move_dir should succeed with symlink from/parent');
    assert.ok(moveDirOut.includes('from_path_kind: symlink'));
    assert.ok(moveDirOut.includes('to_parent_path_kind: symlink'));
    assert.ok(moveDirOut.includes('moved_entry_count: 1'));
    assert.equal(await exists(path.join(moveDirDstParentReal, 'moved-dir-link')), true);
    assert.equal(await exists(moveDirTarget), true, 'moving symlink path should keep target dir');

    console.log('✅ fs-symlink-follow tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
