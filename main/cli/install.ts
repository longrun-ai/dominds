#!/usr/bin/env node

/**
 * install subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds install <spec|path> [--local] [--id <appId>] [--enable] [--force]
 */

import fs from 'fs/promises';
import path from 'path';

import { loadAppLockFile, upsertLockedApp, writeAppLockFileIfChanged } from '../apps/app-lock-file';
import { resolveStableAssignedPort } from '../apps/assigned-port';
import {
  APPS_RESOLUTION_REL_PATH,
  loadAppsResolutionFile,
  upsertResolvedApp,
  writeAppsResolutionFile,
  type AppsResolutionEntry,
} from '../apps/resolution-file';
import { runDomindsAppJsonViaLocalPackage, runDomindsAppJsonViaNpx } from '../apps/run-app-json';

type InstallArgs = Readonly<{
  specOrPath: string;
  force: boolean;
  enable: boolean;
  local: boolean;
  idOverride: string | null;
}>;

function printHelp(): void {
  console.log(`Usage:
  dominds install <spec|path> [--local] [--id <appId>] [--enable] [--force]

Options:
  --local              Treat <spec|path> as a local package directory (dev package)
  --id <appId>         Require app id (must match app --json appId)
  --enable             Enable immediately after install
  --force              Replace existing installed entry with the same id

Notes:
  - State is stored in ${APPS_RESOLUTION_REL_PATH} under the current rtws (process.cwd()).
  - dominds installs apps by running '<app> --json' via npx or local package bin.
`);
}

function parseArgs(argv: readonly string[]): InstallArgs {
  const positional: string[] = [];
  let force = false;
  let enable = false;
  let local = false;
  let idOverride: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--enable') {
      enable = true;
      continue;
    }
    if (a === '--local') {
      local = true;
      continue;
    }
    if (a === '--id') {
      const v = argv[i + 1];
      if (!v) throw new Error('Missing value for --id');
      idOverride = v.trim() || null;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    }
    positional.push(a);
  }

  if (positional.length !== 1) {
    throw new Error('install requires exactly one <spec|path>');
  }

  return { specOrPath: positional[0], force, enable, local, idOverride };
}

async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rtwsRootAbs = process.cwd();
  let args: InstallArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const specOrPath = args.specOrPath.trim();
  if (specOrPath === '') {
    console.error('Error: <spec|path> must be non-empty');
    process.exit(1);
    return;
  }

  const localAbs = path.resolve(rtwsRootAbs, specOrPath);
  const shouldUseLocal = args.local || (await pathIsDirectory(localAbs));

  const loadedResolution = await loadAppsResolutionFile({ rtwsRootAbs });
  if (loadedResolution.kind === 'error') {
    console.error(
      `Error: failed to read ${APPS_RESOLUTION_REL_PATH}: ${loadedResolution.errorText}`,
    );
    process.exit(1);
    return;
  }

  const installJson = shouldUseLocal
    ? await runDomindsAppJsonViaLocalPackage({ packageRootAbs: localAbs })
    : await runDomindsAppJsonViaNpx({ spec: specOrPath, cwdAbs: rtwsRootAbs });

  if (args.idOverride && args.idOverride !== installJson.appId) {
    console.error(`Error: --id '${args.idOverride}' does not match appId '${installJson.appId}'`);
    process.exit(1);
    return;
  }

  const prev = loadedResolution.file.apps.find((a) => a.id === installJson.appId) ?? null;
  if (prev && !args.force) {
    console.error(
      `Error: app '${installJson.appId}' already installed. Use 'dominds update ${installJson.appId}' or 'dominds install ... --force'.`,
    );
    process.exit(1);
    return;
  }

  const userEnabled = args.enable || (prev ? prev.userEnabled : false);
  const enabled = userEnabled;

  const assignedPort = await resolveStableAssignedPort({
    appId: installJson.appId,
    installJson,
    existingApps: loadedResolution.file.apps,
    existingAssignedPort: prev?.assignedPort ?? null,
  });

  const entry: AppsResolutionEntry = {
    id: installJson.appId,
    enabled,
    userEnabled,
    source: shouldUseLocal
      ? { kind: 'local', pathAbs: localAbs }
      : { kind: 'npx', spec: specOrPath },
    assignedPort,
    installJson,
  };

  const nextFile = upsertResolvedApp({ existing: loadedResolution.file, next: entry });
  await writeAppsResolutionFile({ rtwsRootAbs, file: nextFile });

  try {
    const loadedLock = await loadAppLockFile({ rtwsRootAbs });
    if (loadedLock.kind === 'error') {
      console.error(`Warning: failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
    } else {
      const nextLock = upsertLockedApp({
        existing: loadedLock.file,
        next: {
          id: entry.id,
          source: entry.source,
          package: {
            name: entry.installJson.package.name,
            version: entry.installJson.package.version,
          },
        },
      });
      await writeAppLockFileIfChanged({ rtwsRootAbs, file: nextLock });
    }
  } catch (err: unknown) {
    console.error(
      `Warning: failed to update .minds/app-lock.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(
    shouldUseLocal
      ? `Installed app '${entry.id}' from local package: ${localAbs}`
      : `Installed app '${entry.id}' via npx spec: ${specOrPath}`,
  );
  if (enabled) {
    console.log(`Enabled app '${entry.id}'`);
  }
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
