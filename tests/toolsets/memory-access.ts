#!/usr/bin/env tsx

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Dialog } from 'dominds/dialog';
import { setWorkLanguage } from 'dominds/shared/runtime-language';
import { Team } from 'dominds/team';
import { addMemoryTool, addSharedMemoryTool } from 'dominds/tools/mem';

function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (Object.is(actual, expected)) return;
  throw new Error(
    `${message || 'Assertion failed'}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  console.log(`\n=== Testing: ${name} ===`);
  try {
    await testFn();
    console.log('✅ PASS');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ FAIL: ${message}`);
    process.exit(1);
  }
}

async function withTempCwd<T>(fn: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-mem-access-'));
  const prevCwd = process.cwd();

  try {
    process.chdir(tmpDir);
    return await fn(tmpDir);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  setWorkLanguage('en');

  await runTest('Personal memory ignores access-control write rules', async () => {
    await withTempCwd(async () => {
      const caller = new Team.Member({
        id: 'pm',
        name: 'Product Manager',
        write_dirs: ['dominds/docs/**'],
        no_write_dirs: ['.minds/**'],
      });

      const dlg = {} as unknown as Dialog;
      const res = await addMemoryTool.call(dlg, caller, '@add_memory onboarding.md', '# Hello\n');

      assertEqual(res.status, 'completed');

      const writtenPath = path.resolve('.minds/memory/individual/pm/onboarding.md');
      assertTrue(fs.existsSync(writtenPath), `Expected file to be written: ${writtenPath}`);
      assertEqual(fs.readFileSync(writtenPath, 'utf8'), '# Hello\n');
    });
  });

  await runTest('Team shared memory ignores access-control write rules', async () => {
    await withTempCwd(async () => {
      const caller = new Team.Member({
        id: 'pm',
        name: 'Product Manager',
        write_dirs: ['dominds/docs/**'],
        no_write_dirs: ['.minds/**'],
      });

      const dlg = {} as unknown as Dialog;
      const res = await addSharedMemoryTool.call(
        dlg,
        caller,
        '@add_team_memory decisions.md',
        'ok',
      );

      assertEqual(res.status, 'completed');

      const writtenPath = path.resolve('.minds/memory/team_shared/decisions.md');
      assertTrue(fs.existsSync(writtenPath), `Expected file to be written: ${writtenPath}`);
      assertEqual(fs.readFileSync(writtenPath, 'utf8'), 'ok');
    });
  });

  await runTest('Memory path rejects absolute file paths', async () => {
    await withTempCwd(async () => {
      const caller = new Team.Member({ id: 'pm', name: 'Product Manager' });
      const dlg = {} as unknown as Dialog;
      const res = await addMemoryTool.call(dlg, caller, '@add_memory /etc/passwd', 'nope');

      assertEqual(res.status, 'failed');
      assertTrue(
        typeof res.result === 'string' && res.result.includes('relative'),
        `Expected a relative-path error, got: ${res.result}`,
      );
    });
  });

  console.log('\n🎉 All tests passed!');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
