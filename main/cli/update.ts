#!/usr/bin/env node

/**
 * update subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds update [<appId>]
 */

import path from 'path';

import {
  INSTALLED_APPS_REL_PATH,
  findInstalledApp,
  loadInstalledAppsFile,
  upsertInstalledApp,
  writeInstalledAppsFile,
  type InstalledAppEntry,
} from '../apps/installed-file';
import { runDomindsAppJsonViaLocalPackage, runDomindsAppJsonViaNpx } from '../apps/run-app-json';
import { resolveStableAppRuntimePort } from '../apps/runtime-port';
import { formatUnifiedTimestamp } from '../shared/utils/time';

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
  const loaded = await loadInstalledAppsFile({ rtwsRootAbs });
  if (loaded.kind === 'error') {
    console.error(`Error: failed to read ${INSTALLED_APPS_REL_PATH}: ${loaded.errorText}`);
    process.exit(1);
    return;
  }

  const targets: InstalledAppEntry[] =
    args.appId === null
      ? [...loaded.file.apps]
      : (() => {
          const found = findInstalledApp(loaded.file, args.appId);
          if (!found) {
            console.error(`Error: app '${args.appId}' not installed`);
            process.exit(1);
            return [];
          }
          return [found];
        })();

  let nextFile = loaded.file;
  const now = formatUnifiedTimestamp(new Date());

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

    const runtimePort = await resolveStableAppRuntimePort({
      appId: entry.id,
      installJson,
      existingApps: nextFile.apps,
      existingRuntimePort: entry.runtime.port,
    });

    const updated: InstalledAppEntry = {
      ...entry,
      runtime: { port: runtimePort },
      installJson,
      updatedAt: now,
    };
    nextFile = upsertInstalledApp({ existing: nextFile, next: updated });
    console.log(`Updated app '${entry.id}'`);
  }

  await writeInstalledAppsFile({ rtwsRootAbs, file: nextFile });
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
