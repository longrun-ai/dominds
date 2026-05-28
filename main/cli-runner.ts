#!/usr/bin/env node

/**
 * Business CLI runner for dominds
 *
 * Usage:
 *   dominds [subcommand] [options]
 *
 * Subcommands:
 *   webui    - Start WebUI server (default)
 *   tui      - Start Text User Interface
 *   run      - Run task dialog (alias for tui)
 *   read     - Read team configuration
 *   man      - Render toolset manual to stdout
 *   manual   - Alias for man
 *   validate_team_def - Validate explicit team toolset declarations
 *   cert     - Create and inspect local HTTPS certificates
 *   create   - Create a new runtime workspace (rtws) from a template
 *   install  - Install a Dominds App into this rtws
 *   doctor   - Diagnose Dominds App state in this rtws
 *   enable   - Enable an installed Dominds App in this rtws
 *   disable  - Disable an installed Dominds App in this rtws
 *   uninstall- Uninstall a Dominds App from this rtws
 *   update   - Update installed Dominds App(s)
 *   new      - Alias for create
 *   help     - Show help
 *
 * This file is launched by the top-level dominds supervisor.
 */

import * as fs from 'fs';
import * as http from 'node:http';
import * as path from 'path';

import { initAppsRuntime, registerEnabledAppsToolProxies } from './apps/runtime';
import { loadRtwsDotenv } from './bootstrap/dotenv';
import { main as certMain } from './cli/cert';
import { main as createMain } from './cli/create';
import { main as disableMain } from './cli/disable';
import { main as doctorMain } from './cli/doctor';
import { main as enableMain } from './cli/enable';
import { main as installMain } from './cli/install';
import { main as manualMain } from './cli/manual';
import { main as readMain } from './cli/read';
import { main as tuiMain } from './cli/tui';
import { main as uninstallMain } from './cli/uninstall';
import { main as updateMain } from './cli/update';
import { main as validateTeamDefMain } from './cli/validate-team-def';
import { main as webuiMain } from './cli/webui';
import { setRtwsProcessTitle } from './process-title';
import './tools/builtins';

type HttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv(env?: NodeJS.ProcessEnv): void;
};

export function configureEnvProxySupport(): void {
  const domindsUseEnvProxy = process.env.DOMINDS_USE_ENV_PROXY?.trim();
  if (domindsUseEnvProxy === '0') {
    return;
  }

  try {
    const setGlobalProxyFromEnv = (http as Partial<HttpWithEnvProxy>).setGlobalProxyFromEnv;
    if (typeof setGlobalProxyFromEnv !== 'function') {
      console.error(
        'Error: DOMINDS_USE_ENV_PROXY requires Node.js 24.5+ because http.setGlobalProxyFromEnv() is unavailable.',
      );
      process.exit(1);
    }
    setGlobalProxyFromEnv(process.env);
  } catch (err) {
    console.error(
      'Error: invalid proxy environment configuration:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Dominds CLI - AI-driven DevOps framework with persistent memory

Usage:
  dominds [-C <dir>] [subcommand] [options]

Global Options:
  -C <dir>            Change runtime workspace directory (handled by the dominds supervisor)

Subcommands:
  webui [options]    Start WebUI server (default)
  tui [options]      Start Text User Interface
  run [options]      Run task dialog (alias for tui)
  read [options]     Read team configuration
  man [options]      Render toolset manual to stdout
  manual [options]   Alias for man
  validate_team_def [options] Validate explicit team toolset declarations
  cert [options]     Create and inspect local HTTPS certificates
  create [options]   Create a new runtime workspace (rtws) from a template
  install [options]  Install a Dominds App into this rtws
  doctor [options]   Read-only diagnosis across manifest/lock/configuration/resolution/handshake
  enable [options]   Enable an installed Dominds App in this rtws
  disable [options]  Disable an installed Dominds App in this rtws
  uninstall [options] Uninstall a Dominds App from this rtws
  update [options]   Update installed Dominds App(s)
  new [options]      Alias for create
  help               Show this help message

Examples:
  dominds                    # Start WebUI server (default)
  dominds webui              # Start WebUI server
  dominds -C /path/to/my-ws webui # Start in specific rtws
  dominds -C ux-rtws webui        # Relative -C is resolved by the supervisor
  dominds tui --help         # Show TUI help
  dominds run task.tsk       # Run task dialog
  dominds read               # Read team configuration
  dominds man ws_read --lang zh --all
  dominds validate_team_def  # Validate toolset references in .minds/team.yaml
  dominds cert create --host 192.168.1.10
  dominds cert status        # Inspect detected LAN HTTPS certificate status
  dominds create web-scaffold my-project   # Create rtws from a template
  dominds doctor @longrun-ai/web-dev       # Diagnose a single app across all app-state layers

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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = argv;

  // Handle no arguments - default to webui
  if (args.length === 0) {
    loadRtwsDotenv({ cwd: process.cwd() });
    configureEnvProxySupport();
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
    subcommand === 'cert' ||
    subcommandArgs.includes('--help') ||
    (subcommand === 'tui' && subcommandArgs.includes('-h')) ||
    (subcommand === 'run' && subcommandArgs.includes('-h')) ||
    (subcommand === 'read' && subcommandArgs.includes('-h')) ||
    (subcommand === 'validate_team_def' && subcommandArgs.includes('-h')) ||
    (subcommand === 'man' && subcommandArgs.includes('-h')) ||
    (subcommand === 'manual' && subcommandArgs.includes('-h')) ||
    ((subcommand === 'create' || subcommand === 'new') && subcommandArgs.includes('-h')) ||
    (subcommand === 'install' &&
      (subcommandArgs.includes('--help') || subcommandArgs.includes('-h'))) ||
    (subcommand === 'doctor' &&
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
    // Load runtime workspace env files into process.env once, in the main entry.
    // Precedence: `.env` then `.env.local` (later overwrites earlier), and both
    // overwrite any existing process.env values.
    loadRtwsDotenv({ cwd: process.cwd() });
    configureEnvProxySupport();
  }

  const shouldLoadApps =
    subcommand !== 'webui' &&
    subcommand !== 'cert' &&
    subcommand !== 'create' &&
    subcommand !== 'new' &&
    subcommand !== 'install' &&
    subcommand !== 'doctor' &&
    subcommand !== 'enable' &&
    subcommand !== 'disable' &&
    subcommand !== 'uninstall' &&
    subcommand !== 'update';

  if (!shouldSkipRtwsSetup && shouldLoadApps) {
    try {
      // Register toolset proxies so Team.load() can validate toolset bindings (read/man/manual included).
      await registerEnabledAppsToolProxies({ rtwsRootAbs: process.cwd() });

      // Start apps-host only for interactive runtime commands (do not auto-start app frontends for read/man/manual).
      const shouldStartAppsHost = subcommand === 'tui' || subcommand === 'run';
      if (shouldStartAppsHost) {
        await initAppsRuntime({
          rtwsRootAbs: process.cwd(),
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
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
    case 'man':
      await runSubcommand('manual', subcommandArgs);
      break;
    case 'manual':
      await runSubcommand('manual', subcommandArgs);
      break;
    case 'validate_team_def':
      await runSubcommand('validate_team_def', subcommandArgs);
      break;
    case 'cert':
      await runSubcommand('cert', subcommandArgs);
      break;
    case 'create':
    case 'new':
      await runSubcommand('create', subcommandArgs);
      break;
    case 'install':
      await runSubcommand('install', subcommandArgs);
      break;
    case 'doctor':
      await runSubcommand('doctor', subcommandArgs);
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

async function runSubcommand(subcommand: string, args: readonly string[]): Promise<void> {
  try {
    setRtwsProcessTitle();

    if (subcommand === 'webui') {
      await webuiMain(args);
    } else if (subcommand === 'tui') {
      await tuiMain(args);
    } else if (subcommand === 'read') {
      await readMain(args);
    } else if (subcommand === 'manual') {
      await manualMain(args);
    } else if (subcommand === 'validate_team_def') {
      await validateTeamDefMain(args);
    } else if (subcommand === 'cert') {
      await certMain(args);
    } else if (subcommand === 'create') {
      await createMain(args);
    } else if (subcommand === 'install') {
      await installMain(args);
    } else if (subcommand === 'doctor') {
      await doctorMain(args);
    } else if (subcommand === 'enable') {
      await enableMain(args);
    } else if (subcommand === 'disable') {
      await disableMain(args);
    } else if (subcommand === 'uninstall') {
      await uninstallMain(args);
    } else if (subcommand === 'update') {
      await updateMain(args);
    } else {
      console.error(`Error: Subcommand '${subcommand}' not implemented`);
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `Failed to execute subcommand '${subcommand}': ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
