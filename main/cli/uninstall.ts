#!/usr/bin/env node

/**
 * uninstall subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds uninstall <appId> [--purge]
 */

import fs from 'fs/promises';
import path from 'path';

import {
  INSTALLED_APPS_REL_PATH,
  findInstalledApp,
  loadInstalledAppsFile,
  removeInstalledApp,
  writeInstalledAppsFile,
} from '../apps/installed-file';

type UninstallArgs = Readonly<{
  appId: string;
  purge: boolean;
}>;

function printHelp(): void {
  console.log(`Usage:
  dominds uninstall <appId> [--purge]

Options:
  --purge   Also delete rtws app state directory: .apps/<appId>/
`);
}

function parseArgs(argv: readonly string[]): UninstallArgs {
  const positional: string[] = [];
  let purge = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a === '--purge') {
      purge = true;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }
  if (positional.length !== 1) throw new Error('uninstall requires exactly one <appId>');
  return { appId: positional[0], purge };
}

async function main(): Promise<void> {
  let args: UninstallArgs;
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

  const next = removeInstalledApp({ existing: loaded.file, appId: args.appId });
  await writeInstalledAppsFile({ rtwsRootAbs, file: next });

  if (args.purge) {
    const rtwsAppDirAbs = path.resolve(rtwsRootAbs, '.apps', args.appId);
    await fs.rm(rtwsAppDirAbs, { recursive: true, force: true });
    console.log(`Uninstalled app '${args.appId}' (purged rtws state: .apps/${args.appId}/)`);
  } else {
    console.log(`Uninstalled app '${args.appId}' (rtws data preserved under .apps/${args.appId}/)`);
  }
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
