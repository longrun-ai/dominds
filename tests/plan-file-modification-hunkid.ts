import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/shared/runtime-language';
import { Team } from '../main/team';
import { planFileModificationTool } from '../main/tools/txt';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

function extractHunkId(text: string): string {
  const m = text.match(/^\s*hunk_id:\s*'?([a-z0-9_-]{2,32})'?\s*$/im);
  assert.ok(m && m[1], `expected hunk_id in output; got:\n${text}`);
  return m[1];
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-plan-hunkid-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    await writeText(path.join(tmpRoot, 'a.txt'), ['old', ''].join('\n'));

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const r1 = await planFileModificationTool.call(
      dlg,
      alice,
      '@plan_file_modification a.txt 1~1',
      'new',
    );
    assert.equal(r1.status, 'completed');
    const out1 = r1.result ?? '';
    const hunkId = extractHunkId(out1);

    // Custom ids are not allowed: unknown id should fail.
    const r2 = await planFileModificationTool.call(
      dlg,
      alice,
      '@plan_file_modification a.txt 1~1 !deadbeef',
      'newer',
    );
    assert.equal(r2.status, 'failed');
    assert.ok((r2.result ?? '').includes('Custom hunk ids are not allowed'));

    // Revising an existing hunk id (generated previously) should succeed.
    const r3 = await planFileModificationTool.call(
      dlg,
      alice,
      `@plan_file_modification a.txt 1~1 !${hunkId}`,
      'newer',
    );
    assert.equal(r3.status, 'completed');

    // Another member cannot overwrite alice's planned hunk id.
    const bob = new Team.Member({
      id: 'bob',
      name: 'Bob',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });
    const r4 = await planFileModificationTool.call(
      dlg,
      bob,
      `@plan_file_modification a.txt 1~1 !${hunkId}`,
      'bob-change',
    );
    assert.equal(r4.status, 'failed');
    assert.ok((r4.result ?? '').includes('planned by a different member'));

    console.log('✅ plan-file-modification-hunkid tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
