import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasReadAccess, hasWriteAccess } from '../../main/access-control';
import { Team } from '../../main/team';

async function run(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-rtws-'));

  try {
    await fs.mkdir(path.join(tmpRoot, '.dialogs'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '.dialogs', 'root.txt'), 'root\n', 'utf8');

    await fs.mkdir(path.join(tmpRoot, 'ux-rtws', '.dialogs'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'ux-rtws', '.dialogs', 'nested.txt'), 'nested\n', 'utf8');

    process.chdir(tmpRoot);

    const caller = new Team.Member({ id: 'tester', name: 'Tester' });

    assert.equal(hasReadAccess(caller, '.dialogs'), false);
    assert.equal(hasReadAccess(caller, '.dialogs/root.txt'), false);
    assert.equal(hasWriteAccess(caller, '.dialogs'), false);
    assert.equal(hasWriteAccess(caller, '.dialogs/root.txt'), false);

    assert.equal(hasReadAccess(caller, 'ux-rtws/.dialogs'), true);
    assert.equal(hasReadAccess(caller, 'ux-rtws/.dialogs/nested.txt'), true);
    assert.equal(hasWriteAccess(caller, 'ux-rtws/.dialogs'), true);
    assert.equal(hasWriteAccess(caller, 'ux-rtws/.dialogs/nested.txt'), true);

    assert.equal(hasReadAccess(caller, '.dialogs-keep/root.txt'), true);
    assert.equal(hasWriteAccess(caller, '.dialogs-keep/root.txt'), true);

    console.log('access-control dialogs root deny tests: ok');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`access-control dialogs root deny tests: failed: ${msg}`);
  process.exitCode = 1;
});
