#!/usr/bin/env node

import path from 'node:path';

import { loadAppLockFile } from '../apps/app-lock-file';
import {
  loadAppsConfigurationFile,
  normalizeAppsResolutionStrategy,
  type NormalizedAppsResolutionStrategy,
} from '../apps/configuration-file';
import { resolveAppsGraphState, type AppsResolutionIssue } from '../apps/enabled-apps';
import {
  DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  loadDomindsAppManifest,
  loadRtwsDeclaredAppDependencies,
  type DomindsAppDependency,
} from '../apps/manifest';
import {
  loadAppsResolutionFile,
  type AppsResolutionEntry,
  type AppsResolutionSource,
} from '../apps/resolution-file';

type DoctorArgs = Readonly<{ appId: string | null }>;

type FreshProbeSummary = Readonly<{
  appId: string;
  source: AppsResolutionSource;
  hostModuleRelPath: string;
  hostExportName: string;
  packageName: string;
  packageVersion: string | null;
}>;

type DiagnosisStatus = 'healthy' | 'degraded';

type AppDiagnosis = Readonly<{
  appId: string;
  status: DiagnosisStatus;
  declared: boolean;
  declaredAsOptional: boolean;
  lockedPackage: string | null;
  disabled: boolean;
  resolutionEntry: AppsResolutionEntry | null;
  freshProbe: FreshProbeSummary | null;
  reasons: ReadonlyArray<string>;
  nextActions: ReadonlyArray<string>;
}>;

function printHelp(): void {
  console.log(`Usage:
  dominds doctor [<appId>]

Notes:
  - doctor is read-only: it compares .minds/app.yaml, .minds/app-lock.yaml,
    .apps/configuration.yaml, .apps/resolution.yaml, and a fresh app handshake probe.
  - doctor does not rewrite resolution/lock/config files.
  - Run this first when an app is missing, unexpectedly disabled, or behaving
    differently from the current package handshake.
`);
}

function parseArgs(argv: readonly string[]): DoctorArgs {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error('doctor accepts at most one <appId>');
  return { appId: positional[0] ?? null };
}

function formatSource(source: AppsResolutionSource): string {
  return source.kind === 'local' ? `local:${source.pathAbs}` : `npx:${source.spec}`;
}

function formatLockedPackage(name: string, version: string | null): string {
  return version && version.trim() !== '' ? `${name}@${version}` : name;
}

function formatStrategy(strategy: NormalizedAppsResolutionStrategy): string {
  const roots = strategy.localRoots.join(', ');
  return `order=[${strategy.order.join(', ')}], localRoots=[${roots}]`;
}

function quoteOrNone(value: string | null): string {
  return value === null ? '(none)' : value;
}

function addReason(reasons: string[], text: string): void {
  if (!reasons.includes(text)) reasons.push(text);
}

function addNextAction(nextActions: string[], text: string): void {
  if (!nextActions.includes(text)) nextActions.push(text);
}

function summarizeIssue(params: { issue: AppsResolutionIssue; appId: string }): string | null {
  const { issue, appId } = params;
  const detailAppId = typeof issue.detail['appId'] === 'string' ? issue.detail['appId'] : null;
  const dependencyId =
    typeof issue.detail['dependencyId'] === 'string' ? issue.detail['dependencyId'] : null;
  if (detailAppId !== appId && dependencyId !== appId) return null;
  return issue.message;
}

async function runDoctor(params: { rtwsRootAbs: string; appId: string | null }): Promise<{
  declaredDeps: ReadonlyArray<DomindsAppDependency>;
  declaredAppIds: ReadonlySet<string>;
  lockById: ReadonlyMap<string, { name: string; version: string | null }>;
  disabledApps: ReadonlySet<string>;
  strategy: NormalizedAppsResolutionStrategy;
  resolutionById: ReadonlyMap<string, AppsResolutionEntry>;
  freshResolutionById: ReadonlyMap<string, AppsResolutionEntry>;
  issues: ReadonlyArray<AppsResolutionIssue>;
  diagnoses: ReadonlyArray<AppDiagnosis>;
}> {
  const declaredDeps = await loadRtwsDeclaredAppDependencies({ rtwsRootAbs: params.rtwsRootAbs });
  const declaredAppIds = new Set(declaredDeps.map((dep) => dep.id));
  const loadedSelfManifest = await loadDomindsAppManifest({
    packageRootAbs: params.rtwsRootAbs,
    manifestRelPath: DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  });
  const selfManifest = loadedSelfManifest.kind === 'ok' ? loadedSelfManifest.manifest : null;

  const loadedLock = await loadAppLockFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedLock.kind === 'error') {
    throw new Error(`Failed to read .minds/app-lock.yaml: ${loadedLock.errorText}`);
  }

  const loadedConfig = await loadAppsConfigurationFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedConfig.kind === 'error') {
    throw new Error(`Failed to read .apps/configuration.yaml: ${loadedConfig.errorText}`);
  }

  const loadedResolution = await loadAppsResolutionFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedResolution.kind === 'error') {
    throw new Error(`Failed to read .apps/resolution.yaml: ${loadedResolution.errorText}`);
  }

  const fresh = await resolveAppsGraphState({ rtwsRootAbs: params.rtwsRootAbs });
  const strategy = normalizeAppsResolutionStrategy(loadedConfig.file.resolutionStrategy);
  const disabledApps = new Set(loadedConfig.file.disabledApps ?? []);

  const lockById = new Map<string, { name: string; version: string | null }>();
  for (const entry of loadedLock.file.apps) {
    lockById.set(entry.id, { name: entry.package.name, version: entry.package.version });
  }

  const resolutionById = new Map<string, AppsResolutionEntry>();
  for (const entry of loadedResolution.file.apps) {
    resolutionById.set(entry.id, entry);
  }

  const freshResolutionById = new Map<string, AppsResolutionEntry>();
  for (const entry of fresh.resolutionFile.apps) {
    freshResolutionById.set(entry.id, entry);
  }

  const appIds = new Set<string>();
  for (const dep of declaredDeps) appIds.add(dep.id);
  for (const entry of loadedLock.file.apps) appIds.add(entry.id);
  for (const appId of disabledApps) appIds.add(appId);
  for (const entry of loadedResolution.file.apps) appIds.add(entry.id);
  for (const entry of fresh.resolutionFile.apps) appIds.add(entry.id);
  if (params.appId) appIds.add(params.appId);

  const diagnoses: AppDiagnosis[] = [];
  for (const appId of [...appIds].sort()) {
    if (params.appId !== null && appId !== params.appId) continue;

    const isSelfTarget = appId === '.';
    const dep = declaredDeps.find((item) => item.id === appId) ?? null;
    const declaredSelf = isSelfTarget && selfManifest !== null;
    const locked = lockById.get(appId) ?? null;
    const disabled = disabledApps.has(appId);
    const resolutionEntry = resolutionById.get(appId) ?? null;
    const freshEntry = freshResolutionById.get(appId) ?? null;
    const reasons: string[] = [];
    const nextActions: string[] = [];

    if (!dep && !declaredSelf) {
      addReason(reasons, 'not declared in .minds/app.yaml dependencies');
      addNextAction(
        nextActions,
        `Add '${appId}' to .minds/app.yaml dependencies if this app should be active in the rtws.`,
      );
    }
    if (disabled) {
      addReason(reasons, 'explicitly disabled in .apps/configuration.yaml.disabledApps');
      addNextAction(
        nextActions,
        `Remove '${appId}' from .apps/configuration.yaml.disabledApps or run 'dominds enable ${appId}'.`,
      );
    }
    if (locked && freshEntry && locked.name !== freshEntry.installJson.package.name) {
      addReason(
        reasons,
        `lock package mismatch: lock=${formatLockedPackage(locked.name, locked.version)} fresh=${formatLockedPackage(
          freshEntry.installJson.package.name,
          freshEntry.installJson.package.version,
        )}`,
      );
      addNextAction(
        nextActions,
        `Run 'dominds update ${appId}' to refresh .minds/app-lock.yaml after confirming the new package source is correct.`,
      );
    }
    if (resolutionEntry && !freshEntry) {
      addReason(
        reasons,
        'resolution snapshot still has an entry, but fresh probe could not resolve it',
      );
      addNextAction(
        nextActions,
        `Inspect .apps/resolution.yaml and the current resolution strategy, then run 'dominds update ${appId}' after fixing the source.`,
      );
    }
    if (!resolutionEntry && freshEntry) {
      addReason(
        reasons,
        'fresh probe resolves the app, but .apps/resolution.yaml has no snapshot entry yet',
      );
      addNextAction(
        nextActions,
        `Run 'dominds update ${appId}' to materialize the current resolved state into .apps/resolution.yaml.`,
      );
    }
    if (resolutionEntry && freshEntry) {
      if (formatSource(resolutionEntry.source) !== formatSource(freshEntry.source)) {
        addReason(
          reasons,
          `source mismatch: snapshot=${formatSource(resolutionEntry.source)} fresh=${formatSource(freshEntry.source)}`,
        );
        addNextAction(
          nextActions,
          `Re-check resolutionStrategy/local roots and run 'dominds update ${appId}' if the fresh source is the intended one.`,
        );
      }
      if (
        resolutionEntry.installJson.host.moduleRelPath !== freshEntry.installJson.host.moduleRelPath
      ) {
        addReason(
          reasons,
          `entry module mismatch: snapshot=${resolutionEntry.installJson.host.moduleRelPath} fresh=${freshEntry.installJson.host.moduleRelPath}`,
        );
        addNextAction(
          nextActions,
          `The app entry must come from handshake only. Refresh the snapshot with 'dominds update ${appId}' after confirming the app package's handshake output.`,
        );
      }
      if (resolutionEntry.installJson.host.exportName !== freshEntry.installJson.host.exportName) {
        addReason(
          reasons,
          `entry export mismatch: snapshot=${resolutionEntry.installJson.host.exportName} fresh=${freshEntry.installJson.host.exportName}`,
        );
        addNextAction(
          nextActions,
          `The app factory export must come from handshake only. Refresh the snapshot with 'dominds update ${appId}' after confirming the app package's handshake output.`,
        );
      }
    }

    for (const issue of fresh.issues) {
      const summary = summarizeIssue({ issue, appId });
      if (summary !== null) addReason(reasons, `issue: ${summary}`);
    }

    if (reasons.length === 0) {
      addNextAction(
        nextActions,
        'No action required. Current declarations, snapshot, and fresh handshake are consistent.',
      );
    }

    diagnoses.push({
      appId,
      status: reasons.length === 0 ? 'healthy' : 'degraded',
      declared: dep !== null || declaredSelf,
      declaredAsOptional: dep?.optional === true,
      lockedPackage: locked ? formatLockedPackage(locked.name, locked.version) : null,
      disabled,
      resolutionEntry,
      freshProbe: freshEntry
        ? {
            appId: freshEntry.id,
            source: freshEntry.source,
            hostModuleRelPath: freshEntry.installJson.host.moduleRelPath,
            hostExportName: freshEntry.installJson.host.exportName,
            packageName: freshEntry.installJson.package.name,
            packageVersion: freshEntry.installJson.package.version,
          }
        : null,
      reasons,
      nextActions,
    });
  }

  return {
    declaredDeps,
    declaredAppIds,
    lockById,
    disabledApps,
    strategy,
    resolutionById,
    freshResolutionById,
    issues: fresh.issues,
    diagnoses,
  };
}

function printDiagnosis(params: {
  diagnosis: AppDiagnosis;
  strategy: NormalizedAppsResolutionStrategy;
}): void {
  const { diagnosis, strategy } = params;
  console.log(`App: ${diagnosis.appId}`);
  console.log(`  status: ${diagnosis.status}`);
  console.log(
    `  declared: ${diagnosis.declared ? `yes${diagnosis.declaredAsOptional ? ' (optional)' : ' (required)'}` : 'no'}`,
  );
  console.log(`  locked package: ${quoteOrNone(diagnosis.lockedPackage)}`);
  console.log(`  disabled: ${diagnosis.disabled ? 'yes' : 'no'}`);
  console.log(`  resolution strategy: ${formatStrategy(strategy)}`);
  if (diagnosis.resolutionEntry) {
    console.log(`  resolution snapshot source: ${formatSource(diagnosis.resolutionEntry.source)}`);
    console.log(
      `  resolution snapshot entry: ${diagnosis.resolutionEntry.installJson.host.moduleRelPath}#${diagnosis.resolutionEntry.installJson.host.exportName}`,
    );
  } else {
    console.log('  resolution snapshot source: (none)');
    console.log('  resolution snapshot entry: (none)');
  }

  if (diagnosis.freshProbe) {
    console.log(`  fresh handshake source: ${formatSource(diagnosis.freshProbe.source)}`);
    console.log(
      `  fresh handshake entry: ${diagnosis.freshProbe.hostModuleRelPath}#${diagnosis.freshProbe.hostExportName}`,
    );
    console.log(
      `  fresh handshake package: ${formatLockedPackage(diagnosis.freshProbe.packageName, diagnosis.freshProbe.packageVersion)}`,
    );
  } else {
    console.log('  fresh handshake source: (unresolved)');
    console.log('  fresh handshake entry: (unresolved)');
    console.log('  fresh handshake package: (unresolved)');
  }

  console.log('  reasons:');
  for (const reason of diagnosis.reasons.length > 0 ? diagnosis.reasons : ['none']) {
    console.log(`    - ${reason}`);
  }
  console.log('  next actions:');
  for (const action of diagnosis.nextActions) {
    console.log(`    - ${action}`);
  }
}

async function main(): Promise<void> {
  let args: DoctorArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    process.exit(1);
    return;
  }

  const rtwsRootAbs = process.cwd();
  const report = await runDoctor({ rtwsRootAbs, appId: args.appId });
  console.log(`Doctor report for ${path.resolve(rtwsRootAbs)}`);
  console.log(`Tracked apps: ${report.diagnoses.length}`);
  console.log(`Global issues: ${report.issues.length}`);
  console.log('');

  if (report.diagnoses.length === 0) {
    console.log('No app declarations or snapshots found.');
    return;
  }

  let hasDegraded = false;
  for (const diagnosis of report.diagnoses) {
    printDiagnosis({ diagnosis, strategy: report.strategy });
    console.log('');
    if (diagnosis.status === 'degraded') hasDegraded = true;
  }

  if (!hasDegraded) {
    console.log('Summary: all inspected apps are healthy and handshake-consistent.');
  } else {
    console.log('Summary: degraded apps detected. Follow the suggested next actions above.');
  }
}

export { main, runDoctor };

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      'Unhandled error:',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
  });
}
