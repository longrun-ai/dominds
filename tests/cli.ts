#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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

Examples:
  pnpm -C tests run rtws -- driver-v2/internal-drive-priming-not-persisted.ts
  pnpm -C tests run rtws -- -C script-rtws driver-v2/subdialog-queue-commit-mirror.ts
`);
}

async function main(): Promise<void> {
  const testsRoot = path.resolve(__dirname);
  const baseCwd = process.cwd();
  const scriptRtws = path.resolve(testsRoot, 'script-rtws');
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
    if (signal) {
      console.error(`Test runner terminated by signal: ${signal}`);
      process.exit(1);
      return;
    }
    process.exit(code ?? 1);
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tests cli failed: ${message}`);
  process.exit(1);
});
