import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasReadAccess, hasWriteAccess } from '../../main/access-control';
import { Team } from '../../main/team';

async function run(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-rtws-ext-'));

  try {
    process.chdir(tmpRoot);

    const unrestricted = new Team.Member({ id: 'unrestricted', name: 'Unrestricted' });
    assert.equal(hasReadAccess(unrestricted, 'src/app.ts'), true);
    assert.equal(hasWriteAccess(unrestricted, 'src/app.ts'), true);

    const readExtOnly = new Team.Member({
      id: 'read-ext-only',
      name: 'ReadExtOnly',
      read_file_ext_names: ['md', '.TS'],
      no_read_file_ext_names: ['tmp', '.bak'],
    });
    assert.equal(hasReadAccess(readExtOnly, 'docs/readme.md'), true);
    assert.equal(hasReadAccess(readExtOnly, 'src/app.ts'), true);
    assert.equal(hasReadAccess(readExtOnly, 'src/app.TMP'), false);
    assert.equal(hasReadAccess(readExtOnly, 'src/app.js'), false);
    assert.equal(hasReadAccess(readExtOnly, 'src/noext'), true);
    assert.equal(hasReadAccess(readExtOnly, 'src'), true);

    const writeRestricted = new Team.Member({
      id: 'write-restricted',
      name: 'WriteRestricted',
      write_dirs: ['docs/**'],
      no_write_dirs: ['docs/private/**'],
      write_file_ext_names: ['json'],
      no_write_file_ext_names: ['tmp'],
    });
    assert.equal(hasWriteAccess(writeRestricted, 'docs/state.json'), true);
    assert.equal(hasWriteAccess(writeRestricted, 'docs/state.tmp'), false);
    assert.equal(hasWriteAccess(writeRestricted, 'docs/state.ts'), false);
    assert.equal(hasWriteAccess(writeRestricted, 'docs/private/state.json'), false);
    assert.equal(hasWriteAccess(writeRestricted, 'notes/state.json'), false);

    const dirAndExt = new Team.Member({
      id: 'dir-and-ext',
      name: 'DirAndExt',
      read_dirs: ['docs/**'],
      no_read_dirs: ['docs/private/**'],
      read_file_ext_names: ['md'],
      no_read_file_ext_names: ['secret'],
    });
    assert.equal(hasReadAccess(dirAndExt, 'docs/guide.md'), true);
    assert.equal(hasReadAccess(dirAndExt, 'docs/guide.ts'), false);
    assert.equal(hasReadAccess(dirAndExt, 'docs/private/guide.md'), false);
    assert.equal(hasReadAccess(dirAndExt, 'src/guide.md'), false);

    assert.equal(hasReadAccess(unrestricted, '../outside.md'), false);
    assert.equal(hasWriteAccess(unrestricted, '../outside.md'), false);

    console.log('access-control file ext names tests: ok');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`access-control file ext names tests: failed: ${msg}`);
  process.exitCode = 1;
});
