import assert from 'node:assert/strict';
import { main as cliMain } from '../../main/cli-runner';

async function main(): Promise<void> {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const capturedStdout: string[] = [];
  const capturedStderr: string[] = [];
  const originalArgvSnapshot = [...originalArgv];

  console.log = (...args: unknown[]): void => {
    capturedStdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]): void => {
    capturedStderr.push(args.map(String).join(' '));
  };
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new Error(`unexpected process.exit(${String(code)})`);
  }) as typeof process.exit;

  try {
    await cliMain(['man', '--list']);
    assert.strictEqual(
      process.argv,
      originalArgv,
      'top-level CLI dispatch must not replace global process.argv while running subcommands',
    );
    assert.deepEqual(
      process.argv,
      originalArgvSnapshot,
      'top-level CLI dispatch must not rewrite global process.argv while running subcommands',
    );
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.argv = originalArgv;
  }

  assert.ok(capturedStdout.some((line) => line.includes('Available toolsets:')));
  assert.deepEqual(capturedStderr, []);
  console.log('subcommand argv isolation tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`subcommand argv isolation tests: failed: ${message}`);
  process.exit(1);
});
