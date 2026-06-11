import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRtwsDotenv } from '../main/bootstrap/dotenv';
import { handleWriteShellEnv } from '../main/server/setup-routes';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const oldCodexHome = process.env.CODEX_HOME;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-setup-shell-env-'));

  try {
    process.chdir(tmpRoot);

    const expectedCodexHome = String.raw`C:\Users\Administrator\.codex-JulianBrooks922012`;
    const writeResult = await handleWriteShellEnv(
      JSON.stringify({
        envVar: 'CODEX_HOME',
        value: expectedCodexHome,
        target: 'env_local',
      }),
    );

    assert.equal(writeResult.kind, 'ok');
    assert.equal(process.env.CODEX_HOME, expectedCodexHome);

    const writtenRaw = await fs.readFile(path.join(tmpRoot, '.env.local'), 'utf-8');
    assert.equal(
      writtenRaw,
      String.raw`CODEX_HOME="C:\\Users\\Administrator\\.codex-JulianBrooks922012"` + '\n',
    );

    delete process.env.CODEX_HOME;
    const loadResult = loadRtwsDotenv({ cwd: tmpRoot });
    assert.deepEqual(loadResult.errors, []);
    assert.equal(process.env.CODEX_HOME, expectedCodexHome);

    console.log('setup-shell-env tests: ok');
  } finally {
    process.chdir(oldCwd);
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
