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
 *   manual   - Render toolset manual to stdout
 *   create   - Create a new runtime workspace (rtws) from a template
 *   install  - Install a Dominds App into this rtws
 *   enable   - Enable an installed Dominds App in this rtws
 *   disable  - Disable an installed Dominds App in this rtws
 *   uninstall- Uninstall a Dominds App from this rtws
 *   update   - Update installed Dominds App(s)
 *   new      - Alias for create
 *   help     - Show help
 *
 * Global installation:
 *   pnpm add -g dominds
 *   dominds webui
 */

import * as fs from 'fs';
import * as path from 'path';

import { initAppsRuntime, registerEnabledAppsToolProxies } from './apps/runtime';
import { main as createMain } from './cli/create';
import { main as disableMain } from './cli/disable';
import { main as enableMain } from './cli/enable';
import { main as installMain } from './cli/install';
import { main as manualMain } from './cli/manual';
import { main as readMain } from './cli/read';
import { main as tuiMain } from './cli/tui';
import { main as uninstallMain } from './cli/uninstall';
import { main as updateMain } from './cli/update';
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
  -C <dir>            Change to runtime workspace directory (rtws) before running

Subcommands:
  webui [options]    Start WebUI server (default)
  tui [options]      Start Text User Interface
  run [options]      Run task dialog (alias for tui)
  read [options]     Read team configuration
  manual [options]   Render toolset manual to stdout
  create [options]   Create a new runtime workspace (rtws) from a template
  install [options]  Install a Dominds App into this rtws
  enable [options]   Enable an installed Dominds App in this rtws
  disable [options]  Disable an installed Dominds App in this rtws
  uninstall [options] Uninstall a Dominds App from this rtws
  update [options]   Update installed Dominds App(s)
  new [options]      Alias for create
  help               Show this help message

Examples:
  dominds                    # Start WebUI server (default)
  dominds webui              # Start WebUI server
  dominds -C ./my-ws webui   # Start in specific rtws
  dominds tui --help         # Show TUI help
  dominds run task.tsk       # Run task dialog
  dominds read               # Read team configuration
  dominds manual ws_read --lang zh --all
  dominds create web-scaffold my-project   # Create rtws from a template

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
    (subcommand === 'read' && subcommandArgs.includes('-h')) ||
    (subcommand === 'manual' && subcommandArgs.includes('-h')) ||
    ((subcommand === 'create' || subcommand === 'new') && subcommandArgs.includes('-h')) ||
    (subcommand === 'install' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h'))) ||
    (subcommand === 'enable' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h'))) ||
    (subcommand === 'disable' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h'))) ||
    (subcommand === 'uninstall' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h'))) ||
    (subcommand === 'update' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h')));

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

  const shouldLoadApps =
    subcommand !== 'webui' &&
    subcommand !== 'create' &&
    subcommand !== 'new' &&
    subcommand !== 'install' &&
    subcommand !== 'enable' &&
    subcommand !== 'disable' &&
    subcommand !== 'uninstall' &&
    subcommand !== 'update';

  if (!shouldSkipRtwsSetup && shouldLoadApps) {
    try {
      // Register toolset proxies so Team.load() can validate toolset bindings (read/manual included).
      await registerEnabledAppsToolProxies({ rtwsRootAbs: process.cwd() });

      // Start apps-host only for interactive runtime commands (do not auto-start app frontends for read/manual).
      const shouldStartAppsHost = subcommand === 'tui' || subcommand === 'run';
      if (shouldStartAppsHost) {
        await initAppsRuntime({
          rtwsRootAbs: process.cwd(),
          kernel: { host: '127.0.0.1', port: 0 },
        });
      }
    } catch (err) {
      console.error(
        'Error: failed to load enabled apps:',
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
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
    case 'manual':
      await runSubcommand('manual', subcommandArgs);
      break;
    case 'create':
    case 'new':
      await runSubcommand('create', subcommandArgs);
      break;
    case 'install':
      await runSubcommand('install', subcommandArgs);
      break;
    case 'enable':
      await runSubcommand('enable', subcommandArgs);
      break;
    case 'disable':
      await runSubcommand('disable', subcommandArgs);
      break;
    case 'uninstall':
      await runSubcommand('uninstall', subcommandArgs);
      break;
    case 'update':
      await runSubcommand('update', subcommandArgs);
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
    } else if (subcommand === 'manual') {
      await manualMain();
    } else if (subcommand === 'create') {
      await createMain();
    } else if (subcommand === 'install') {
      await installMain();
    } else if (subcommand === 'enable') {
      await enableMain();
    } else if (subcommand === 'disable') {
      await disableMain();
    } else if (subcommand === 'uninstall') {
      await uninstallMain();
    } else if (subcommand === 'update') {
      await updateMain();
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
