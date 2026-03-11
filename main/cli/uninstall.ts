#!/usr/bin/env node

import fs from 'node:fs/promises';

import { formatDomindsAppRtwsDirRel, resolveDomindsAppRtwsDirAbs } from '../apps/app-id';
import { loadAppLockFile, removeLockedApp, writeAppLockFileIfChanged } from '../apps/app-lock-file';
import {
  loadAppsConfigurationFile,
  setAppDisabledInConfiguration,
  writeAppsConfigurationFileIfChanged,
} from '../apps/configuration-file';
import {
  DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  loadDomindsAppManifest,
  makeDefaultRtwsAppManifest,
  removeManifestDependency,
  writeDomindsAppManifestIfChanged,
} from '../apps/manifest';
import { refreshAppsDerivedState } from '../apps/workspace-app-state';

type UninstallArgs = Readonly<{ appId: string; purge: boolean }>;

function printHelp(): void {
  console.log(`Usage:
  dominds uninstall <appId> [--purge]

Options:
  --purge   Also delete rtws app state directory: .apps/<appId path segments>/
`);
}

function parseArgs(argv: readonly string[]): UninstallArgs {
  const positional: string[] = [];
  let purge = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--purge') {
      purge = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
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
  const loadedManifest = await loadDomindsAppManifest({
    packageRootAbs: rtwsRootAbs,
    manifestRelPath: DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  });
  const manifest =
    loadedManifest.kind === 'ok' ? loadedManifest.manifest : makeDefaultRtwsAppManifest();
  const nextManifest = removeManifestDependency({
    manifest,
    dependencyId: args.appId,
  });
  if (nextManifest === manifest) {
    console.error(`Error: app '${args.appId}' is not declared in .minds/app.yaml dependencies`);
    process.exit(1);
    return;
  }

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
    appId: args.appId,
    disabled: false,
  });
  await writeAppsConfigurationFileIfChanged({ rtwsRootAbs, file: nextConfig });

  const loadedLock = await loadAppLockFile({ rtwsRootAbs });
  if (loadedLock.kind === 'error') {
    console.error(`Error: failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
    process.exit(1);
    return;
  }
  const nextLock = removeLockedApp({ existing: loadedLock.file, appId: args.appId });
  await writeAppLockFileIfChanged({ rtwsRootAbs, file: nextLock });

  await refreshAppsDerivedState({ rtwsRootAbs });

  if (args.purge) {
    const rtwsDirRel = formatDomindsAppRtwsDirRel(args.appId);
    const appDirAbs = resolveDomindsAppRtwsDirAbs(rtwsRootAbs, args.appId);
    await fs.rm(appDirAbs, { recursive: true, force: true });
    console.log(`Uninstalled app '${args.appId}' (purged rtws state: ${rtwsDirRel}/)`);
  } else {
    console.log(
      `Uninstalled app '${args.appId}' (rtws data preserved under ${formatDomindsAppRtwsDirRel(args.appId)}/)`,
    );
  }
}

export { main };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
