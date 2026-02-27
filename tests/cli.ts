#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extractGlobalRtwsChdir } from '../main/shared/rtws-cli';

function printHelp(): void {
  console.log(`
Dominds Tests CLI

Usage:
  pnpm -C tests run rtws -- [--shared-rtws] [-C <dir>] <script.ts> [script args...]

Notes:
  - Default mode is isolated: each run copies tests/script-rtws into a unique temp rtws.
  - This avoids cross-test pollution and allows safe parallel runs.
  - Use --shared-rtws only for debugging (runs directly in tests/script-rtws).
  - -C is parsed for parity with dominds CLI, but only tests/script-rtws is accepted.
  - Set DOMINDS_TEST_RTWS_KEEP_TMP=1 to keep isolated temp rtws after run.

	Examples:
	  pnpm -C tests run rtws -- kernel-driver/context-assembly-order.ts
	  pnpm -C tests run rtws -- -C script-rtws kernel-driver/subdialog-queue-commit-mirror.ts
	  pnpm -C tests run rtws -- --shared-rtws kernel-driver/subdialog-queue-commit-mirror.ts
	`);
}

type RtwsMode = 'isolated' | 'shared';

type ModeParseResult = Readonly<{
  mode: RtwsMode;
  argv: ReadonlyArray<string>;
}>;

function parseRtwsMode(rawArgv: ReadonlyArray<string>): ModeParseResult {
  const envModeRaw = process.env.DOMINDS_TEST_RTWS_MODE?.trim().toLowerCase();
  let mode: RtwsMode = envModeRaw === 'shared' ? 'shared' : 'isolated';
  const args: string[] = [];
  for (const arg of rawArgv) {
    if (arg === '--shared-rtws') {
      mode = 'shared';
      continue;
    }
    if (arg === '--isolated-rtws') {
      mode = 'isolated';
      continue;
    }
    args.push(arg);
  }
  return { mode, argv: args };
}

async function main(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const baseCwd = process.cwd();
  const templateRtws = path.resolve(testsRoot, 'script-rtws');
  const rawArgv = process.argv.slice(2);
  const normalizedArgv = rawArgv.length > 0 && rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const { mode, argv: argvForParse } = parseRtwsMode(normalizedArgv);

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

  if (!fs.existsSync(templateRtws)) {
    console.error(`Error: required rtws template not found: ${templateRtws}`);
    process.exit(1);
    return;
  }

  if (parsed.chdir && path.resolve(parsed.chdir) !== templateRtws) {
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

  let runRtws = templateRtws;
  let tempRoot: string | null = null;
  if (mode === 'isolated') {
    try {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-tests-rtws-'));
      runRtws = path.join(tempRoot, 'rtws');
      fs.cpSync(templateRtws, runRtws, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: failed to prepare isolated rtws: ${message}`);
      process.exit(1);
      return;
    }
  } else {
    console.warn('[tests/cli] Using shared tests/script-rtws (--shared-rtws).');
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
      cwd: runRtws,
      stdio: 'inherit',
      env: {
        ...process.env,
        DOMINDS_TEST_RTWS_MANAGED: '1',
        DOMINDS_TEST_RTWS_MODE: mode,
        DOMINDS_TEST_RTWS_TEMPLATE: templateRtws,
      },
    },
  );

  const cleanupTempRtws = (): boolean => {
    if (mode !== 'isolated') return true;
    if (!tempRoot) return true;
    if (process.env.DOMINDS_TEST_RTWS_KEEP_TMP === '1') {
      console.error(`[tests/cli] Keeping isolated rtws at ${tempRoot}`);
      return true;
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: failed to cleanup isolated rtws ${tempRoot}: ${message}`);
      return false;
    }
  };

  child.on('error', (err) => {
    console.error(`Test runner failed to start: ${err.message}`);
    const cleaned = cleanupTempRtws();
    process.exit(cleaned ? 1 : 2);
  });

  child.on('exit', (code, signal) => {
    let finalExitCode = code ?? 1;
    if (signal) {
      console.error(`Test runner terminated by signal: ${signal}`);
      finalExitCode = 1;
    }

    const cleaned = cleanupTempRtws();
    if (!cleaned && finalExitCode === 0) {
      finalExitCode = 1;
    }

    process.exit(finalExitCode);
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tests cli failed: ${message}`);
  process.exit(1);
});
