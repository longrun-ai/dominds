import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Execute the real CLI in the supplied workspace; only child transport completion is asserted. */
export function runDomindsCli(args: readonly string[], cwd: string) {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      '--tsconfig',
      path.resolve(__dirname, '../tsconfig.json'),
      path.resolve(__dirname, '../../main/cli.ts'),
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, DOMINDS_USE_ENV_PROXY: '0' },
    },
  );
  if (result.error || result.signal !== null || result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'CLI process must finish without a terminating signal');
  assert.ok(typeof result.status === 'number');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
