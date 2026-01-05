#!/usr/bin/env node

/**
 * Read subcommand for dominds CLI
 *
 * Usage:
 *   dominds read [options] [<member-id>]
 *
 * Options:
 *   -C, --cwd <dir>      Change to workspace directory
 *   --no-hints           Don't show hints
 *   --only-prompt        Show only system prompt
 *   --only-mem           Show only memories
 *   --help               Show help
 */

import { loadAgentMinds } from '../minds/load';

function printUsage(): void {
  console.log(
    'Usage: dominds read [-C <dir>] [<member-id>] [--no-hints] [--only-prompt|--only-mem]',
  );
  console.log('');
  console.log('Print agent system prompt and memories with filtering flags.');
  console.log('');
  console.log('Examples:');
  console.log('  dominds read                    # Read all team members');
  console.log('  dominds read developer          # Read specific member');
  console.log('  dominds read -C ./workspace     # Read from specific workspace');
  console.log('  dominds read --only-prompt      # Show only system prompts');
  console.log('  dominds read --only-mem         # Show only memories');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let chdir: string | undefined;
  let memberId: string | undefined;
  let onlyPrompt = false;
  let onlyMem = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C' || arg === '--cwd') {
      const next = args[i + 1];
      if (!next) {
        console.error('Error: -C requires a directory path');
        printUsage();
        process.exit(1);
      }
      chdir = next;
      i++;
    } else if (arg === '--only-prompt') {
      onlyPrompt = true;
    } else if (arg === '--only-mem') {
      onlyMem = true;
    } else if (arg === '--no-hints') {
      // Deprecated, but keep for compatibility
      console.warn('Warning: --no-hints is deprecated, use --only-prompt or --only-mem instead');
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (!memberId) {
      memberId = arg;
    } else {
      console.error(`Error: unexpected argument '${arg}'`);
      printUsage();
      process.exit(1);
    }
  }

  try {
    if (chdir) {
      process.chdir(chdir);
    }
  } catch (err) {
    console.error(`Error: failed to change directory to '${chdir}':`, err);
    process.exit(1);
  }

  try {
    const { systemPrompt, memories } = await loadAgentMinds(memberId);

    if (!onlyMem) {
      process.stdout.write(systemPrompt.trim() + '\n');
    }

    if (!onlyPrompt) {
      for (const mem of memories) {
        if ('content' in mem && typeof mem.content === 'string' && mem.content.trim()) {
          process.stdout.write('\n' + mem.content.trim() + '\n');
        }
      }
    }
  } catch (err) {
    console.error('Error loading agent minds:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Export main function for use by CLI
export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
