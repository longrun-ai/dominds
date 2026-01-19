#!/usr/bin/env node

/**
 * Main CLI entry point for dominds
 *
 * Usage:
 *   dominds [subcommand] [options]
 *
 * Subcommands:
 *   webui    - Start WebUI server (default)
 *   tui      - Start Text User Interface
 *   run      - Run task dialog (alias for tui)
 *   read     - Read team configuration
 *   help     - Show help
 *
 * Global installation:
 *   pnpm add -g dominds
 *   dominds webui
 */

import * as fs from 'fs';
import * as path from 'path';

import { main as readMain } from './cli/read';
import { main as tuiMain } from './cli/tui';
import { main as webuiMain } from './cli/webui';
import { loadRtwsDotenv } from './shared/dotenv';
import { extractGlobalRtwsChdir } from './shared/rtws-cli';
import './tools/builtins';

function printHelp(): void {
  console.log(`
Dominds CLI - AI-driven DevOps framework with persistent memory

Usage:
  dominds [-C <dir>] [subcommand] [options]

Global Options:
  -C <dir>            Change to workspace directory (rtws) before running

Subcommands:
  webui [options]    Start WebUI server (default)
  tui [options]      Start Text User Interface
  run [options]      Run task dialog (alias for tui)
  read [options]     Read team configuration
  help               Show this help message

Examples:
  dominds                    # Start WebUI server (default)
  dominds webui              # Start WebUI server
  dominds -C ./my-ws webui   # Start in specific workspace
  dominds tui --help         # Show TUI help
  dominds run task.tsk       # Run task dialog
  dominds read               # Read team configuration

Installation:
  pnpm add -g dominds

For detailed help on a specific subcommand:
  dominds <subcommand> --help
`);
}

function printVersion(): void {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    console.log(`dominds v${packageJson.version}`);
  } catch {
    console.log('dominds (version unknown)');
  }
}

async function main(): Promise<void> {
  const baseCwd = process.cwd();
  let parsed: { chdir?: string; argv: ReadonlyArray<string> };
  try {
    parsed = extractGlobalRtwsChdir({ argv: process.argv.slice(2), baseCwd });
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const args = parsed.argv;

  // Handle no arguments - default to webui
  if (args.length === 0) {
    if (parsed.chdir) {
      try {
        const absoluteRtwsRoot = path.isAbsolute(parsed.chdir)
          ? parsed.chdir
          : path.resolve(baseCwd, parsed.chdir);
        process.chdir(absoluteRtwsRoot);
      } catch (err) {
        console.error(`Error: failed to change directory to '${parsed.chdir}':`, err);
        process.exit(1);
      }
    }
    loadRtwsDotenv({ cwd: process.cwd() });
    await runSubcommand('webui', []);
    return;
  }

  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  // Handle help and version flags
  if (subcommand === '-h' || subcommand === '--help' || subcommand === 'help') {
    printHelp();
    process.exit(0);
  }

  if (subcommand === '-v' || subcommand === '--version') {
    printVersion();
    process.exit(0);
  }

  const shouldSkipRtwsSetup =
    subcommandArgs.includes('--help') ||
    (subcommand === 'tui' && subcommandArgs.includes('-h')) ||
    (subcommand === 'run' && subcommandArgs.includes('-h')) ||
    (subcommand === 'read' && subcommandArgs.includes('-h'));

  if (!shouldSkipRtwsSetup) {
    if (parsed.chdir) {
      try {
        const absoluteRtwsRoot = path.isAbsolute(parsed.chdir)
          ? parsed.chdir
          : path.resolve(baseCwd, parsed.chdir);
        process.chdir(absoluteRtwsRoot);
      } catch (err) {
        console.error(`Error: failed to change directory to '${parsed.chdir}':`, err);
        process.exit(1);
      }
    }

    // Load runtime workspace env files into process.env once, in the main entry.
    // Precedence: `.env` then `.env.local` (later overwrites earlier), and both
    // overwrite any existing process.env values.
    loadRtwsDotenv({ cwd: process.cwd() });
  }

  // Route to appropriate subcommand
  switch (subcommand) {
    case 'webui':
      await runSubcommand('webui', subcommandArgs);
      break;
    case 'tui':
    case 'run':
      await runSubcommand('tui', subcommandArgs);
      break;
    case 'read':
      await runSubcommand('read', subcommandArgs);
      break;
    default:
      console.error(`Error: Unknown subcommand '${subcommand}'`);
      console.error(`Run 'dominds help' for usage information.`);
      process.exit(1);
  }
}

async function runSubcommand(subcommand: string, args: string[]): Promise<void> {
  try {
    // Save original argv
    const originalArgv = process.argv;

    // Set argv to simulate direct execution of the subcommand
    process.argv = ['node', subcommand, ...args];

    if (subcommand === 'webui') {
      await webuiMain();
    } else if (subcommand === 'tui') {
      await tuiMain();
    } else if (subcommand === 'read') {
      await readMain();
    } else {
      console.error(`Error: Subcommand '${subcommand}' not implemented`);
      process.exit(1);
    }

    // Restore original argv
    process.argv = originalArgv;
  } catch (err) {
    console.error(`Failed to execute subcommand '${subcommand}':`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
