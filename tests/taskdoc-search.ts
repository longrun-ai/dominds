import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTaskDocumentsInWorkspace } from '../main/utils/taskdoc-search';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-taskdoc-search-'));

  try {
    process.chdir(tmpRoot);

    // Root ignore file.
    await writeText(
      path.join(tmpRoot, '.taskdoc-ignore'),
      ['ignored-root/', '# comment', ''].join('\n'),
    );

    // Create some Task Docs.
    await mkdirp(path.join(tmpRoot, 'included-root.tsk'));
    await writeText(path.join(tmpRoot, 'included-root.tsk', 'goals.md'), '- ok\n');

    await mkdirp(path.join(tmpRoot, 'ignored-root', 'ignored-1.tsk'));
    await mkdirp(path.join(tmpRoot, 'ignored-root', 'nested', 'ignored-2.tsk'));

    await mkdirp(path.join(tmpRoot, 'projects', 'proj1', 'private', 'secret.tsk'));
    await mkdirp(path.join(tmpRoot, 'projects', 'proj1', 'public', 'public-1.tsk'));
    await mkdirp(path.join(tmpRoot, 'projects', 'proj2', 'public-2.tsk'));

    // Nested ignore file (arbitrary dir depth).
    await writeText(
      path.join(tmpRoot, 'projects', 'proj1', '.taskdoc-ignore'),
      ['private/', 'public-ignored.tsk', ''].join('\n'),
    );
    await mkdirp(path.join(tmpRoot, 'projects', 'proj1', 'public-ignored.tsk'));

    const result = await listTaskDocumentsInWorkspace({ rootDir: '.' });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw new Error('unreachable');

    const relPaths = result.taskDocuments.map((d) => d.relativePath);
    assert.deepEqual(relPaths, [
      'included-root.tsk',
      'projects/proj1/public/public-1.tsk',
      'projects/proj2/public-2.tsk',
    ]);

    const rootDoc = result.taskDocuments.find((d) => d.relativePath === 'included-root.tsk');
    assert.ok(rootDoc);
    assert.ok(typeof rootDoc.lastModified === 'string' && rootDoc.lastModified.length > 0);
    assert.ok(rootDoc.size > 0);

    console.log('✅ taskdoc-search tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
