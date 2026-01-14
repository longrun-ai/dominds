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

function printHelp(): void {
  console.log(`
Dominds CLI - AI-driven DevOps framework with persistent memory

Usage:
  dominds [subcommand] [options]

Subcommands:
  webui [options]    Start WebUI server (default)
  tui [options]      Start Text User Interface
  run [options]      Run task dialog (alias for tui)
  read [options]     Read team configuration
  help               Show this help message

Examples:
  dominds                    # Start WebUI server (default)
  dominds webui              # Start WebUI server
  dominds tui --help         # Show TUI help
  dominds run task.md        # Run task dialog
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
  const args = process.argv.slice(2);

  // Handle no arguments - default to webui
  if (args.length === 0) {
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
  // Get the directory where this cli.ts file is located
  const cliDir = __dirname;

  // Try .js extension first (for compiled version), then .ts (for development)
  let scriptPath = path.join(cliDir, 'cli', `${subcommand}.js`);
  if (!fs.existsSync(scriptPath)) {
    scriptPath = path.join(cliDir, 'cli', `${subcommand}.ts`);
  }

  // Check if the script exists
  if (!fs.existsSync(scriptPath)) {
    console.error(`Error: Subcommand '${subcommand}' not implemented`);
    console.error(`Script not found: ${scriptPath.replace(/\.(js|ts)$/, '.{js,ts}')}`);
    process.exit(1);
  }

  // Dynamically import and run the subcommand module
  try {
    // Save original argv
    const originalArgv = process.argv;

    // Set argv to simulate direct execution of the subcommand
    process.argv = ['node', scriptPath, ...args];

    // Import and execute the module
    const module = await import(scriptPath);

    // Check if it has a main function
    if (typeof module.main === 'function') {
      await module.main();
    } else {
      console.error(`Error: Subcommand '${subcommand}' does not export a main function`);
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
