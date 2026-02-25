#!/usr/bin/env node

/**
 * disable subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds disable <appId>
 */

import {
  INSTALLED_APPS_REL_PATH,
  findInstalledApp,
  loadInstalledAppsFile,
  setAppEnabled,
  writeInstalledAppsFile,
} from '../apps/installed-file';

type DisableArgs = Readonly<{ appId: string }>;

function printHelp(): void {
  console.log(`Usage:
  dominds disable <appId>
`);
}

function parseArgs(argv: readonly string[]): DisableArgs {
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1) throw new Error('disable requires exactly one <appId>');
  return { appId: positional[0] };
}

async function main(): Promise<void> {
  let args: DisableArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const rtwsRootAbs = process.cwd();
  const loaded = await loadInstalledAppsFile({ rtwsRootAbs });
  if (loaded.kind === 'error') {
    console.error(`Error: failed to read ${INSTALLED_APPS_REL_PATH}: ${loaded.errorText}`);
    process.exit(1);
    return;
  }

  const found = findInstalledApp(loaded.file, args.appId);
  if (!found) {
    console.error(`Error: app '${args.appId}' not installed`);
    process.exit(1);
    return;
  }

  const next = setAppEnabled({ existing: loaded.file, appId: args.appId, enabled: false });
  await writeInstalledAppsFile({ rtwsRootAbs, file: next });
  console.log(`Disabled app '${args.appId}'`);
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
