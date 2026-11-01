import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRtwsDotenv } from '../main/bootstrap/dotenv';
import { handleWriteShellEnv } from '../main/server/setup-routes';
import { withTempRtws } from './kernel-driver/helpers';

async function main(): Promise<void> {
  const envVar = 'DOMINDS_TEST_SETUP_PATH';
  const previousValue = process.env[envVar];
  try {
    await withTempRtws(async (tmpRoot) => {
      await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
      // Supplied local provider makes this dedicated test variable an allowed setup target.
      await fs.writeFile(
        path.join(tmpRoot, '.minds', 'llm.yaml'),
        'providers:\n  setup-data:\n    name: Supplied setup provider\n    apiType: openai\n    baseUrl: https://example.invalid\n    apiKeyEnvVar: ' +
          envVar +
          '\n    models:\n      supplied-model: {}\n',
      );
      const expectedPath = String.raw`C:\Users\Administrator\.codex-JulianBrooks922012`;
      const writeResult = await handleWriteShellEnv(
        JSON.stringify({
          envVar,
          value: expectedPath,
          target: 'env_local',
        }),
      );

      assert.equal(writeResult.kind, 'ok');
      assert.equal(process.env[envVar], expectedPath);

      const writtenRaw = await fs.readFile(path.join(tmpRoot, '.env.local'), 'utf-8');
      assert.equal(
        writtenRaw,
        String.raw`DOMINDS_TEST_SETUP_PATH="C:\\Users\\Administrator\\.codex-JulianBrooks922012"` +
          '\n',
      );

      delete process.env[envVar];
      const loadResult = loadRtwsDotenv({ cwd: tmpRoot });
      assert.deepEqual(loadResult.errors, []);
      assert.equal(process.env[envVar], expectedPath);

      console.log('setup-shell-env tests: ok');
    });
  } finally {
    if (previousValue === undefined) delete process.env[envVar];
    else process.env[envVar] = previousValue;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
