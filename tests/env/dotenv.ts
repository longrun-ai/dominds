import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRtwsDotenv } from '../../main/bootstrap/dotenv';
import { withTempRtws } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const keys = ['FOO', 'BAR', 'HASH', 'SINGLE', 'EMPTY'].map(
      (key) => `DOMINDS_TEST_DOTENV_${key}`,
    );
    const previous = keys.map((key) => process.env[key]);
    const [foo, bar, hash, single, empty] = keys;
    assert.ok(foo && bar && hash && single && empty);
    try {
      for (const key of keys) delete process.env[key];
      const directory = path.join(rtws, 'dotenv-case');
      await fs.mkdir(directory);
      assert.deepEqual(loadRtwsDotenv({ cwd: directory }), {
        cwd: directory,
        loadedFiles: [],
        errors: [],
      });
      process.env[foo] = 'from_shell';
      await fs.writeFile(path.join(directory, '.env'), `${foo}=from_env\n`);
      await fs.writeFile(path.join(directory, '.env.local'), `${foo}=from_env_local\n`);
      const loaded = loadRtwsDotenv({ cwd: directory });
      assert.deepEqual(loaded, { cwd: directory, loadedFiles: ['.env', '.env.local'], errors: [] });
      assert.equal(process.env[foo], 'from_env_local');
      const input = [
        `export ${bar}="a\\n b\\t\\\"c\\\\d"`,
        `${hash}=abc#data # trailing comment`,
        `${single}='literal\\n#data'`,
        `${empty}=`,
        'missing-equals-data',
        '=empty-key-data',
        'BAD-KEY=invalid-key-data',
        `${foo}=valid-after-errors`,
      ];
      await fs.writeFile(path.join(directory, '.env'), input.join('\n'));
      const parsed = loadRtwsDotenv({ cwd: directory });
      assert.deepEqual(parsed.errors, [
        { file: '.env', lineNumber: 5, raw: input[4], reason: 'missing_equals' },
        { file: '.env', lineNumber: 6, raw: input[5], reason: 'empty_key' },
        { file: '.env', lineNumber: 7, raw: input[6], reason: 'invalid_key' },
      ]);
      assert.equal(process.env[bar], 'a\n b\t"c\\d');
      assert.equal(process.env[hash], 'abc#data');
      assert.equal(process.env[single], 'literal\\n#data');
      assert.equal(process.env[empty], '');
      assert.equal(
        process.env[foo],
        'from_env_local',
        '.env.local precedence survives errors in .env',
      );
      await fs.rm(path.join(directory, '.env.local'));
      assert.deepEqual(loadRtwsDotenv({ cwd: directory }).loadedFiles, ['.env']);
      assert.equal(
        process.env[foo],
        'valid-after-errors',
        'invalid rows do not discard later valid data',
      );
    } finally {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  console.log('dotenv input data, precedence and structured diagnostics: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
