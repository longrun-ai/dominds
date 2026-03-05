#!/usr/bin/env node

/**
 * update subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds update [<appId>]
 */

import path from 'path';

import { loadAppLockFile, upsertLockedApp, writeAppLockFileIfChanged } from '../apps/app-lock-file';
import { resolveStableAssignedPort } from '../apps/assigned-port';
import {
  APPS_RESOLUTION_REL_PATH,
  findResolvedApp,
  loadAppsResolutionFile,
  upsertResolvedApp,
  writeAppsResolutionFile,
  type AppsResolutionEntry,
} from '../apps/resolution-file';
import { runDomindsAppJsonViaLocalPackage, runDomindsAppJsonViaNpx } from '../apps/run-app-json';

type UpdateArgs = Readonly<{
  appId: string | null;
}>;

function printHelp(): void {
  console.log(`Usage:
  dominds update [<appId>]

Notes:
  - When <appId> is omitted, updates all installed apps by re-running their '<app> --json' handshake.
  - Updates installJson and package root info as returned by the app.
`);
}

function parseArgs(argv: readonly string[]): UpdateArgs {
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    positional.push(a);
  }
  if (positional.length > 1) throw new Error('update accepts at most one <appId>');
  return { appId: positional.length === 1 ? positional[0] : null };
}

async function main(): Promise<void> {
  let args: UpdateArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const rtwsRootAbs = process.cwd();
  const loaded = await loadAppsResolutionFile({ rtwsRootAbs });
  if (loaded.kind === 'error') {
    console.error(`Error: failed to read ${APPS_RESOLUTION_REL_PATH}: ${loaded.errorText}`);
    process.exit(1);
    return;
  }

  const loadedLock = await loadAppLockFile({ rtwsRootAbs });
  const shouldUpdateLock = loadedLock.kind === 'ok';
  if (loadedLock.kind === 'error') {
    console.error(`Warning: failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
  }
  let nextLock = loadedLock.kind === 'ok' ? loadedLock.file : null;

  const targets: AppsResolutionEntry[] =
    args.appId === null
      ? [...loaded.file.apps]
      : (() => {
          const found = findResolvedApp(loaded.file, args.appId);
          if (!found) {
            console.error(`Error: app '${args.appId}' not installed`);
            process.exit(1);
            return [];
          }
          return [found];
        })();

  let nextFile = loaded.file;

  for (const entry of targets) {
    const installJson =
      entry.source.kind === 'npx'
        ? await runDomindsAppJsonViaNpx({ spec: entry.source.spec, cwdAbs: rtwsRootAbs })
        : await runDomindsAppJsonViaLocalPackage({
            packageRootAbs: path.resolve(entry.source.pathAbs),
          });

    if (installJson.appId !== entry.id) {
      throw new Error(
        `Update failed: appId mismatch for '${entry.id}': got '${installJson.appId}' from --json handshake`,
      );
    }

    const assignedPort = await resolveStableAssignedPort({
      appId: entry.id,
      installJson,
      existingApps: nextFile.apps,
      existingAssignedPort: entry.assignedPort,
    });

    const updated: AppsResolutionEntry = {
      ...entry,
      assignedPort,
      installJson,
    };
    nextFile = upsertResolvedApp({ existing: nextFile, next: updated });

    if (shouldUpdateLock && nextLock) {
      nextLock = upsertLockedApp({
        existing: nextLock,
        next: {
          id: updated.id,
          source: updated.source,
          package: {
            name: updated.installJson.package.name,
            version: updated.installJson.package.version,
          },
        },
      });
    }
    console.log(`Updated app '${entry.id}'`);
  }

  await writeAppsResolutionFile({ rtwsRootAbs, file: nextFile });

  if (shouldUpdateLock && nextLock) {
    try {
      await writeAppLockFileIfChanged({ rtwsRootAbs, file: nextLock });
    } catch (err: unknown) {
      console.error(
        `Warning: failed to update .minds/app-lock.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
