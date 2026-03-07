#!/usr/bin/env node

/**
 * install subcommand for dominds CLI (Apps)
 *
 * Usage:
 *   dominds install <spec|path> [--local] [--id <appId>] [--enable] [--force]
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAppLockFile, upsertLockedApp, writeAppLockFileIfChanged } from '../apps/app-lock-file';
import {
  loadAppsConfigurationFile,
  setAppDisabledInConfiguration,
  writeAppsConfigurationFileIfChanged,
} from '../apps/configuration-file';
import {
  DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  loadDomindsAppManifest,
  makeDefaultRtwsAppManifest,
  upsertManifestDependency,
  writeDomindsAppManifestIfChanged,
} from '../apps/manifest';
import {
  loadAppsResolutionFile,
  upsertResolvedApp,
  writeAppsResolutionFileIfChanged,
} from '../apps/resolution-file';
import { runDomindsAppJsonViaLocalPackage, runDomindsAppJsonViaNpx } from '../apps/run-app-json';
import { refreshAppsDerivedState } from '../apps/workspace-app-state';

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
  --id <appId>         Require app id (must match app --dominds-app appId)
  --enable             Remove the app from disabledApps after install
  --force              Reserved for future use; currently ignored

Notes:
  - install adds the app to .minds/app.yaml dependencies.
  - app resolution source is determined dynamically via .apps/configuration.yaml resolutionStrategy.
`);
}

function parseArgs(argv: readonly string[]): InstallArgs {
  const positional: string[] = [];
  let force = false;
  let enable = false;
  let local = false;
  let idOverride: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--enable') {
      enable = true;
      continue;
    }
    if (arg === '--local') {
      local = true;
      continue;
    }
    if (arg === '--id') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --id');
      idOverride = value.trim() || null;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length !== 1) throw new Error('install requires exactly one <spec|path>');
  return { specOrPath: positional[0], force, enable, local, idOverride };
}

async function pathIsDirectory(pathAbs: string): Promise<boolean> {
  try {
    const stat = await fs.stat(pathAbs);
    return stat.isDirectory();
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
  const installJson = shouldUseLocal
    ? await runDomindsAppJsonViaLocalPackage({ packageRootAbs: localAbs })
    : await runDomindsAppJsonViaNpx({ spec: specOrPath, cwdAbs: rtwsRootAbs });

  if (args.idOverride && args.idOverride !== installJson.appId) {
    console.error(`Error: --id '${args.idOverride}' does not match appId '${installJson.appId}'`);
    process.exit(1);
    return;
  }

  const loadedManifest = await loadDomindsAppManifest({
    packageRootAbs: rtwsRootAbs,
    manifestRelPath: DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  });
  const manifest =
    loadedManifest.kind === 'ok' ? loadedManifest.manifest : makeDefaultRtwsAppManifest();
  const nextManifest = upsertManifestDependency({
    manifest,
    dependency: { id: installJson.appId },
  });
  await writeDomindsAppManifestIfChanged({
    packageRootAbs: rtwsRootAbs,
    manifestRelPath: DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
    manifest: nextManifest,
  });

  const loadedConfig = await loadAppsConfigurationFile({ rtwsRootAbs });
  if (loadedConfig.kind === 'error') {
    console.error(`Error: failed to read .apps/configuration.yaml: ${loadedConfig.errorText}`);
    process.exit(1);
    return;
  }

  const nextConfig = setAppDisabledInConfiguration({
    existing: loadedConfig.file,
    appId: installJson.appId,
    disabled: args.enable
      ? false
      : isAppCurrentlyDisabled(loadedConfig.file.disabledApps, installJson.appId),
  });
  await writeAppsConfigurationFileIfChanged({ rtwsRootAbs, file: nextConfig });

  const loadedLock = await loadAppLockFile({ rtwsRootAbs });
  if (loadedLock.kind === 'error') {
    console.error(`Error: failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
    process.exit(1);
    return;
  }
  const nextLock = upsertLockedApp({
    existing: loadedLock.file,
    next: {
      id: installJson.appId,
      package: {
        name: installJson.package.name,
        version: installJson.package.version,
      },
    },
  });
  await writeAppLockFileIfChanged({ rtwsRootAbs, file: nextLock });

  if (shouldUseLocal) {
    const loadedResolution = await loadAppsResolutionFile({ rtwsRootAbs });
    if (loadedResolution.kind === 'error') {
      console.error(`Error: failed to read .apps/resolution.yaml: ${loadedResolution.errorText}`);
      process.exit(1);
      return;
    }
    const nextResolution = upsertResolvedApp({
      existing: loadedResolution.file,
      next: {
        id: installJson.appId,
        enabled: true,
        source: { kind: 'local', pathAbs: localAbs },
        assignedPort: null,
        installJson,
      },
    });
    await writeAppsResolutionFileIfChanged({ rtwsRootAbs, file: nextResolution });
  }

  await refreshAppsDerivedState({ rtwsRootAbs });

  void args.force;
  console.log(
    shouldUseLocal
      ? `Installed app '${installJson.appId}' from local package: ${localAbs}`
      : `Installed app '${installJson.appId}' via resolver strategy seed: ${specOrPath}`,
  );
  if (args.enable) {
    console.log(`Enabled app '${installJson.appId}'`);
  }
}

function isAppCurrentlyDisabled(
  disabledApps: ReadonlyArray<string> | undefined,
  appId: string,
): boolean {
  return (disabledApps ?? []).includes(appId);
}

export { main };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
