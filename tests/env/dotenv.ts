import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadRtwsDotenv } from '../../main/shared/dotenv';

function withEnv(keys: ReadonlyArray<string>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];

  try {
    fn();
  } finally {
    for (const key of keys) {
      const prev = previous[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function main(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-dotenv-'));
  const keys = ['DOMINDS_TEST_DOTENV_FOO', 'DOMINDS_TEST_DOTENV_BAR'] as const;

  withEnv(keys, () => {
    process.env.DOMINDS_TEST_DOTENV_FOO = 'from_shell';

    writeFile(path.join(tmp, '.env'), 'DOMINDS_TEST_DOTENV_FOO=from_env\n');
    writeFile(path.join(tmp, '.env.local'), 'DOMINDS_TEST_DOTENV_FOO=from_env_local\n');

    const result = loadRtwsDotenv({ cwd: tmp });
    assert.equal(result.cwd, tmp);
    assert.deepEqual(result.loadedFiles, ['.env', '.env.local']);
    assert.equal(result.errors.length, 0);

    // `.env.local` overwrites `.env`, and files overwrite existing process.env.
    assert.equal(process.env.DOMINDS_TEST_DOTENV_FOO, 'from_env_local');

    // Basic parsing sanity.
    writeFile(path.join(tmp, '.env'), 'DOMINDS_TEST_DOTENV_BAR="a\\n b"\n');
    const result2 = loadRtwsDotenv({ cwd: tmp });
    assert.equal(result2.errors.length, 0);
    assert.equal(process.env.DOMINDS_TEST_DOTENV_BAR, 'a\n b');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

main();
