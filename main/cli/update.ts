#!/usr/bin/env node

import { loadAppLockFile, upsertLockedApp, writeAppLockFileIfChanged } from '../apps/app-lock-file';
import { hasRtwsDeclaredAppDependency } from '../apps/manifest';
import { refreshAppsDerivedState } from '../apps/workspace-app-state';
import { formatDoctorGuidance, formatMutationBoundaryNote } from './apps-cli-hints';

type UpdateArgs = Readonly<{ appId: string | null }>;

function printHelp(): void {
  console.log(`Usage:
  dominds update [<appId>]

Notes:
  - Re-runs dynamic app resolution using .minds/app.yaml + .apps/configuration.yaml.
  - Refreshes derived state in .apps/resolution.yaml and .minds/app-lock.yaml.
  - update recomputes derived state; it does not explain root-cause mismatches in
    declaration, disabled state, resolution snapshots, or handshake entry fields.
  - ${formatMutationBoundaryNote({
    commandName: 'update',
    layerDescription: '.minds/app-lock.yaml and .apps/resolution.yaml derived state',
  })}
`);
}

function parseArgs(argv: readonly string[]): UpdateArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error('update accepts at most one <appId>');
  return { appId: positional[0] ?? null };
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
  if (
    args.appId !== null &&
    !(await hasRtwsDeclaredAppDependency({ rtwsRootAbs, appId: args.appId }))
  ) {
    console.error(`Error: app '${args.appId}' is not declared in .minds/app.yaml dependencies`);
    console.error(formatDoctorGuidance({ appId: args.appId }));
    process.exit(1);
    return;
  }

  const resolution = await refreshAppsDerivedState({ rtwsRootAbs });

  const loadedLock = await loadAppLockFile({ rtwsRootAbs });
  if (loadedLock.kind === 'error') {
    console.error(`Error: failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
    console.error(formatDoctorGuidance({ appId: args.appId }));
    process.exit(1);
    return;
  }
  let nextLock = loadedLock.file;
  for (const app of resolution.apps) {
    if (args.appId !== null && app.id !== args.appId) continue;
    nextLock = upsertLockedApp({
      existing: nextLock,
      next: {
        id: app.id,
        package: {
          name: app.installJson.package.name,
          version: app.installJson.package.version,
        },
      },
    });
  }
  await writeAppLockFileIfChanged({ rtwsRootAbs, file: nextLock });

  if (args.appId === null) {
    for (const app of resolution.apps) {
      console.log(
        `Updated app '${app.id}' derived state in .minds/app-lock.yaml and .apps/resolution.yaml.`,
      );
    }
    console.log(
      formatMutationBoundaryNote({
        commandName: 'update',
        layerDescription: '.minds/app-lock.yaml and .apps/resolution.yaml derived state',
      }),
    );
    return;
  }

  console.log(
    `Updated app '${args.appId}' derived state in .minds/app-lock.yaml and .apps/resolution.yaml.`,
  );
  console.log(
    formatMutationBoundaryNote({
      commandName: 'update',
      layerDescription: '.minds/app-lock.yaml and .apps/resolution.yaml derived state',
      appId: args.appId,
    }),
  );
}

export { main };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
