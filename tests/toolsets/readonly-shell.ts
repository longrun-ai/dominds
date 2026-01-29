#!/usr/bin/env tsx

import type { Dialog } from 'dominds/dialog';
import { setWorkLanguage } from 'dominds/shared/runtime-language';
import { Team } from 'dominds/team';
import { readonlyShellTool } from 'dominds/tools/os';

function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

function assertIncludes(haystack: string, needle: string, message?: string): void {
  assertTrue(
    haystack.includes(needle),
    message || `Assertion failed: expected output to include '${needle}'`,
  );
}

function assertNotIncludes(haystack: string, needle: string, message?: string): void {
  assertTrue(
    !haystack.includes(needle),
    message || `Assertion failed: expected output NOT to include '${needle}'`,
  );
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== Testing: ${name} ===`);
  try {
    await fn();
    console.log('✅ PASS');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ FAIL: ${message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Make tool output deterministic for assertions.
  setWorkLanguage('en');

  const caller = new Team.Member({
    id: 'pm',
    name: 'Product Manager',
    write_dirs: ['**/*'],
    no_write_dirs: [],
  });

  const dlg = {} as unknown as Dialog;

  await runTest('allows find for simple inspection', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'find . -maxdepth 1 -type f -print',
      timeout_ms: 2_000,
    });
    assertNotIncludes(out, '❌ readonly_shell', 'Expected find to be accepted');
  });

  await runTest('allows uname/whoami/id', async () => {
    const outUname = await readonlyShellTool.call(dlg, caller, {
      command: 'uname -a',
      timeout_ms: 2_000,
    });
    assertNotIncludes(outUname, '❌ readonly_shell', 'Expected uname to be accepted');

    const outWhoami = await readonlyShellTool.call(dlg, caller, {
      command: 'whoami',
      timeout_ms: 2_000,
    });
    assertNotIncludes(outWhoami, '❌ readonly_shell', 'Expected whoami to be accepted');

    const outId = await readonlyShellTool.call(dlg, caller, {
      command: 'id',
      timeout_ms: 2_000,
    });
    assertNotIncludes(outId, '❌ readonly_shell', 'Expected id to be accepted');
  });

  await runTest('allows echo', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'echo hello',
      timeout_ms: 2_000,
    });
    assertNotIncludes(out, '❌ readonly_shell', 'Expected echo to be accepted');
  });

  await runTest('allows printf/awk', async () => {
    const outPrintf = await readonlyShellTool.call(dlg, caller, {
      command: "printf '%s' hello",
      timeout_ms: 2_000,
    });
    assertNotIncludes(outPrintf, '❌ readonly_shell', 'Expected printf to be accepted');

    const outAwk = await readonlyShellTool.call(dlg, caller, {
      command: "awk 'BEGIN{print 1}'",
      timeout_ms: 2_000,
    });
    assertNotIncludes(outAwk, '❌ readonly_shell', 'Expected awk to be accepted');
  });

  await runTest('allows git -C relative status', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'git -C dominds status --porcelain',
      timeout_ms: 2_000,
    });
    assertNotIncludes(out, '❌ readonly_shell', 'Expected git -C <relative> status to be accepted');
  });

  await runTest('rejects git -C absolute path', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'git -C / status',
      timeout_ms: 2_000,
    });
    assertIncludes(out, '❌ readonly_shell', 'Expected absolute -C path to be rejected');
    assertIncludes(out, 'git -C <relative-path>', 'Expected hint about git -C usage');
  });

  await runTest('allows cd && chain inside rtws', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'cd dominds && git status --porcelain',
      timeout_ms: 2_000,
    });
    assertNotIncludes(out, '❌ readonly_shell', 'Expected cd && chain to be accepted');
  });

  await runTest('rejects cd with parent traversal', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'cd .. && ls',
      timeout_ms: 2_000,
    });
    assertIncludes(out, '❌ readonly_shell', 'Expected cd .. to be rejected');
  });

  await runTest('deny message allowlist mentions find', async () => {
    const out = await readonlyShellTool.call(dlg, caller, {
      command: 'ps aux',
      timeout_ms: 2_000,
    });
    assertIncludes(out, 'only allows these command prefixes', 'Expected prefix deny message');
    assertIncludes(out, 'find', 'Expected allowlist to mention find');
    assertIncludes(out, 'git diff', 'Expected allowlist to mention git diff');
    assertIncludes(out, 'tree', 'Expected allowlist to mention tree');
    assertIncludes(out, 'jq', 'Expected allowlist to mention jq');
    assertIncludes(out, 'uname', 'Expected allowlist to mention uname');
    assertIncludes(out, 'whoami', 'Expected allowlist to mention whoami');
    assertIncludes(out, 'id', 'Expected allowlist to mention id');
    assertIncludes(out, 'echo', 'Expected allowlist to mention echo');
    assertIncludes(out, 'pwd', 'Expected allowlist to mention pwd');
    assertIncludes(out, 'which', 'Expected allowlist to mention which');
    assertIncludes(out, 'date', 'Expected allowlist to mention date');
    assertIncludes(out, 'diff', 'Expected allowlist to mention diff');
    assertIncludes(out, 'realpath', 'Expected allowlist to mention realpath');
    assertIncludes(out, 'readlink', 'Expected allowlist to mention readlink');
    assertIncludes(out, 'printf', 'Expected allowlist to mention printf');
    assertIncludes(out, 'cut', 'Expected allowlist to mention cut');
    assertIncludes(out, 'sort', 'Expected allowlist to mention sort');
    assertIncludes(out, 'uniq', 'Expected allowlist to mention uniq');
    assertIncludes(out, 'tr', 'Expected allowlist to mention tr');
    assertIncludes(out, 'awk', 'Expected allowlist to mention awk');
    assertIncludes(out, 'shasum', 'Expected allowlist to mention shasum');
    assertIncludes(out, 'sha256sum', 'Expected allowlist to mention sha256sum');
    assertIncludes(out, 'md5sum', 'Expected allowlist to mention md5sum');
    assertIncludes(out, 'uuid', 'Expected allowlist to mention uuid');
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Unexpected error:', message);
  process.exit(1);
});
