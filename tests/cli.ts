#!/usr/bin/env tsx

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extractGlobalRtwsChdir } from '../main/shared/rtws-cli';

function printHelp(): void {
  console.log(`
Dominds Tests CLI

Usage:
  pnpm -C tests run rtws -- [-C <dir>] <script.ts> [script args...]

Notes:
  - Test rtws is fixed to tests/script-rtws.
  - -C is parsed for parity with dominds CLI, but only tests/script-rtws is accepted.
  - After each run, tests/script-rtws is restored to pre-run snapshot by default.
    Optional mode: DOMINDS_TEST_RTWS_RESTORE_MODE=head (restore to git HEAD).
    Set DOMINDS_TEST_RTWS_RESTORE=0 to disable auto-restore for debugging.

Examples:
  pnpm -C tests run rtws -- driver-v2/internal-drive-priming-not-persisted.ts
  pnpm -C tests run rtws -- -C script-rtws driver-v2/subdialog-queue-commit-mirror.ts
`);
}

type RestoreMode = 'off' | 'snapshot' | 'head';

function resolveRestoreMode(): RestoreMode {
  if (process.env.DOMINDS_TEST_RTWS_RESTORE === '0') {
    return 'off';
  }
  const raw = process.env.DOMINDS_TEST_RTWS_RESTORE_MODE;
  if (raw === undefined || raw.trim() === '') {
    return 'snapshot';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'snapshot') {
    return 'snapshot';
  }
  if (normalized === 'head') {
    return 'head';
  }
  throw new Error(
    `Invalid DOMINDS_TEST_RTWS_RESTORE_MODE=${JSON.stringify(raw)} (expected "snapshot" or "head")`,
  );
}

type GitRunResult = Readonly<{
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function runGit(repoRoot: string, args: ReadonlyArray<string>): GitRunResult {
  const res = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

function restoreScriptRtwsToGitHead(
  testsRoot: string,
): { ok: true } | { ok: false; message: string } {
  const repoRoot = path.resolve(testsRoot, '..');
  const relScriptRtws = path.relative(repoRoot, path.resolve(testsRoot, 'script-rtws'));
  const relForGit = relScriptRtws.split(path.sep).join('/');

  const inside = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    return {
      ok: false,
      message: `git rev-parse failed (status=${String(inside.status)}): ${inside.stderr || inside.stdout}`,
    };
  }

  const restoreTracked = runGit(repoRoot, [
    'restore',
    '--worktree',
    '--source=HEAD',
    '--',
    relForGit,
  ]);
  if (!restoreTracked.ok) {
    return {
      ok: false,
      message: `git restore failed (status=${String(restoreTracked.status)}): ${restoreTracked.stderr || restoreTracked.stdout}`,
    };
  }

  const cleanUntracked = runGit(repoRoot, ['clean', '-fd', '--', relForGit]);
  if (!cleanUntracked.ok) {
    return {
      ok: false,
      message: `git clean failed (status=${String(cleanUntracked.status)}): ${cleanUntracked.stderr || cleanUntracked.stdout}`,
    };
  }

  return { ok: true };
}

function restoreScriptRtwsFromSnapshot(args: {
  snapshotDir: string;
  scriptRtws: string;
}): { ok: true } | { ok: false; message: string } {
  const { snapshotDir, scriptRtws } = args;
  try {
    const normalizedScriptRtws = path.resolve(scriptRtws);
    if (!normalizedScriptRtws.endsWith(`${path.sep}script-rtws`)) {
      return {
        ok: false,
        message: `Safety check failed: expected script-rtws path, got ${normalizedScriptRtws}`,
      };
    }
    fs.rmSync(normalizedScriptRtws, { recursive: true, force: true });
    fs.cpSync(snapshotDir, normalizedScriptRtws, { recursive: true });
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

async function main(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const baseCwd = process.cwd();
  const scriptRtws = path.resolve(testsRoot, 'script-rtws');
  let restoreMode: RestoreMode;
  try {
    restoreMode = resolveRestoreMode();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
    return;
  }
  const rawArgv = process.argv.slice(2);
  const argvForParse = rawArgv.length > 0 && rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;

  let parsed: { chdir?: string; argv: ReadonlyArray<string> };
  try {
    parsed = extractGlobalRtwsChdir({ argv: argvForParse, baseCwd });
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const args = parsed.argv;
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    printHelp();
    process.exit(0);
    return;
  }

  if (!fs.existsSync(scriptRtws)) {
    console.error(`Error: required rtws not found: ${scriptRtws}`);
    process.exit(1);
    return;
  }

  if (parsed.chdir && path.resolve(parsed.chdir) !== scriptRtws) {
    console.error(
      `Error: only tests/script-rtws is allowed for script tests. Requested: ${parsed.chdir}`,
    );
    process.exit(1);
    return;
  }

  const [scriptRelOrAbs, ...scriptArgs] = args;
  const scriptAbs = path.isAbsolute(scriptRelOrAbs)
    ? scriptRelOrAbs
    : path.resolve(testsRoot, scriptRelOrAbs);

  if (!fs.existsSync(scriptAbs)) {
    console.error(`Error: script not found: ${scriptAbs}`);
    process.exit(1);
    return;
  }

  let snapshotDir: string | null = null;
  if (restoreMode === 'snapshot') {
    try {
      snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-tests-script-rtws-'));
      fs.cpSync(scriptRtws, snapshotDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: failed to snapshot tests/script-rtws before run: ${message}`);
      process.exit(1);
      return;
    }
  }

  const child = spawn(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      '--tsconfig',
      path.resolve(testsRoot, 'tsconfig.json'),
      scriptAbs,
      ...scriptArgs,
    ],
    {
      cwd: scriptRtws,
      stdio: 'inherit',
      env: {
        ...process.env,
        DOMINDS_TEST_RTWS_MANAGED: '1',
      },
    },
  );

  child.on('exit', (code, signal) => {
    let finalExitCode = code ?? 1;
    if (signal) {
      console.error(`Test runner terminated by signal: ${signal}`);
      finalExitCode = 1;
    }

    if (restoreMode === 'snapshot') {
      if (!snapshotDir) {
        console.error(`Error: snapshot restore requested but snapshotDir is missing`);
        finalExitCode = 1;
      } else {
        const restored = restoreScriptRtwsFromSnapshot({ snapshotDir, scriptRtws });
        if (!restored.ok) {
          console.error(
            `Error: failed to restore tests/script-rtws from snapshot: ${restored.message}`,
          );
          finalExitCode = 1;
        }
      }
    } else if (restoreMode === 'head') {
      const restored = restoreScriptRtwsToGitHead(testsRoot);
      if (!restored.ok) {
        console.error(
          `Error: failed to restore tests/script-rtws to git HEAD: ${restored.message}`,
        );
        finalExitCode = 1;
      }
    }

    process.exit(finalExitCode);
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tests cli failed: ${message}`);
  process.exit(1);
});
