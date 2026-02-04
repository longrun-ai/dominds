#!/usr/bin/env node

/**
 * TUI subcommand for dominds CLI
 *
 * Usage:
 *   dominds tui [options] <taskdoc-path> [prompts...]
 *   dominds run [options] <taskdoc-path> [prompts...]
 *
 * Options:
 *   -m, --member <id>: Specify team member ID to use as agent
 *   -i, --id <dialog-id>: Resume existing dialog or use custom dialog ID
 *   --list: List all dialogs (running, completed, archived)
 *   --help: Show help message
 *   -p, --print-only: Non-interactive mode (for automated testing)
 *   --version: Show version information
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../log';

// Helper function to get package version
function getPackageVersion(): string {
  try {
    const packagePath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return packageJson.version || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function showVersion() {
  console.log(`dominds v${getPackageVersion()}`);
}

function showHelp() {
  console.log(`dominds v${getPackageVersion()}`);
  console.log('');
  console.log('Usage: dominds tui [options] [taskdoc] [prompt]');
  console.log('       dominds run [options] [taskdoc] [prompt]');
  console.log('');
  console.log('Start or continue a dialog with an AI team member using a Taskdoc.');
  console.log('');
  console.log(
    "Note: rtws (runtime workspace) directory is `process.cwd()`. Use 'dominds -C <dir> tui ...' to run in another rtws.",
  );
  console.log('');
  console.log('Arguments:');
  console.log('  <taskdoc-path>    Path to Taskdoc (required for dialog)');
  console.log('  [prompts...]      Optional initial prompts');
  console.log('');
  console.log('Options:');
  console.log('  -m <member>            Specify team member');
  console.log('  -i <dialog-id>         Resume dialog with specified ID');
  console.log('  -p, --print-only       Non-interactive mode (for automated testing)');
  console.log('  --list                 List all dialogs');
  console.log('  --version              Show version information');
  console.log('  --help                 Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  dominds tui task.tsk "implement feature"');
  console.log('  dominds tui -i abc123');
  console.log('  dominds tui --list');
  console.log('  dominds tui --version');
  console.log('');
  console.log('Note: All bare arguments (without -- prefix) are treated as Taskdocs');
  console.log('      or prompts, ensuring no conflicts with user files.');
}

function parseArgs(argv: string[]) {
  const out: {
    member?: string;
    taskDocPath?: string;
    dialogId?: string;
    list?: boolean;
    help?: boolean;
    version?: boolean;
    nonInteractive?: boolean;
    prompts: string[];
  } = { prompts: [] };

  let inOptions = true;
  let taskDocPathSet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (inOptions) {
      if (a === '--') {
        inOptions = false;
        continue;
      }
      if (a === '-m' || a === '--member') {
        const next = argv[i + 1];
        if (next == null) {
          throw new Error(`${a} requires a team member ID argument`);
        }
        out.member = next;
        i++;
        continue;
      }
      if (a === '-i' || a === '--id') {
        const next = argv[i + 1];
        if (next == null) {
          throw new Error(`${a} requires a dialog ID argument`);
        }
        out.dialogId = next;
        i++;
        continue;
      }
      if (a === '--list') {
        out.list = true;
        continue;
      }
      if (a === '--version') {
        out.version = true;
        continue;
      }
      if (a === '--help' || a === '-h') {
        out.help = true;
        continue;
      }
      if (a === '-p' || a === '--print-only') {
        out.nonInteractive = true;
        continue;
      }
      if (a.startsWith('-')) {
        throw new Error(`Unknown option: ${a}`);
      }

      // Check for invalid commands that look like commands but aren't recognized
      if (a.includes('-') && !a.includes('.') && !a.includes('/')) {
        throw new Error(`Unknown command: ${a}. Use --help to see available commands.`);
      }

      // First non-option token is mandatory taskDocPath
      if (!taskDocPathSet) {
        out.taskDocPath = a;
        taskDocPathSet = true;
        continue;
      }
      // Subsequent non-option tokens before -- count as prompts
      out.prompts.push(a);
      continue;
    }

    // After --, treat everything as prompt fragments (including dash-started)
    out.prompts.push(a);
  }
  return out;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    // Handle version flag
    if (args.version) {
      showVersion();
      return;
    }

    // Handle help flag
    if (args.help) {
      showHelp();
      return;
    }

    if (args.taskDocPath && !args.list) {
      const normalized = args.taskDocPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      if (!normalized.endsWith('.tsk')) {
        throw new Error(
          `taskdoc-path must be a Taskdoc directory ending in '.tsk' (got: '${args.taskDocPath}')`,
        );
      }
    }

    console.log(`Dominds TUI not implemented yet.`);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Export main function for use by CLI
export { main };

if (require.main === module) {
  main().catch((error) => {
    log.error('CLI execution failed', error);
    process.exit(1);
  });
}
