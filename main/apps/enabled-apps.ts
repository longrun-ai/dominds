import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAppLockFile, type AppLockEntry } from './app-lock-file';
import { resolveStableAssignedPortWithReason } from './assigned-port';
import {
  APPS_CONFIGURATION_REL_PATH,
  DEFAULT_APPS_RESOLUTION_STRATEGY,
  loadAppsConfigurationFile,
  type AppsResolutionStrategy,
  type AppsResolutionStrategyOrderItem,
} from './configuration-file';
import {
  loadDomindsAppManifest,
  loadRtwsDeclaredAppDependencies,
  type DomindsAppDependency,
} from './manifest';
import { readPackageInfo } from './package-info';
import {
  APPS_RESOLUTION_REL_PATH,
  loadAppsResolutionFile,
  writeAppsResolutionFileIfChanged,
  type AppsResolutionEntry,
  type AppsResolutionFile,
  type AppsResolutionSource,
} from './resolution-file';
import { runDomindsAppJsonViaLocalPackage, runDomindsAppJsonViaNpx } from './run-app-json';

export type EnabledAppSnapshotEntry = Readonly<{
  id: string;
  runtimePort: number | null;
  installJson: AppsResolutionEntry['installJson'];
  source: AppsResolutionEntry['source'];
}>;

export type AppsResolutionIssue = Readonly<{
  kind:
    | 'required_dependency_missing'
    | 'required_dependency_disabled'
    | 'app_manifest_load_failed'
    | 'app_effectively_disabled_due_to_required_dependency'
    | 'assigned_port_reassigned';
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail: Readonly<Record<string, unknown>>;
}>;

export type EnabledAppsSnapshot = Readonly<{
  enabledApps: ReadonlyArray<EnabledAppSnapshotEntry>;
  issues: ReadonlyArray<AppsResolutionIssue>;
}>;

function getRuntimePort(entry: AppsResolutionEntry): number | null {
  if (entry.assignedPort !== null) return entry.assignedPort;
  const defaultPort = entry.installJson.frontend?.defaultPort;
  return typeof defaultPort === 'number' && defaultPort > 0 ? defaultPort : null;
}

type NormalizedAppsResolutionStrategy = Readonly<{
  order: ReadonlyArray<AppsResolutionStrategyOrderItem>;
  localRoots: ReadonlyArray<string>;
}>;

type ResolvedAppProbe = Readonly<{
  source: AppsResolutionSource;
  installJson: AppsResolutionEntry['installJson'];
}>;

type ResolvedGraphState = Readonly<{
  resolutionFile: AppsResolutionFile;
  issues: ReadonlyArray<AppsResolutionIssue>;
}>;

type LockedAppHint = Readonly<{
  packageName: string;
  version: string | null;
}>;

async function dirExists(dirPathAbs: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPathAbs);
    return stat.isDirectory();
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) return false;
    throw err;
  }
}

function normalizeStrategy(
  raw: AppsResolutionStrategy | undefined,
): NormalizedAppsResolutionStrategy {
  const order =
    raw?.order ??
    DEFAULT_APPS_RESOLUTION_STRATEGY.order ??
    (['local'] satisfies ReadonlyArray<'local'>);
  const localRoots = raw?.localRoots ??
    DEFAULT_APPS_RESOLUTION_STRATEGY.localRoots ?? ['dominds-apps'];

  if (order.length === 0) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.order must not be empty`,
    );
  }
  if (localRoots.length === 0) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.localRoots must not be empty`,
    );
  }
  if (new Set(order).size !== order.length) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.order has duplicates`,
    );
  }
  if (new Set(localRoots).size !== localRoots.length) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.localRoots has duplicates`,
    );
  }

  return { order, localRoots };
}

function getResolutionHint(params: { rtwsRootAbs: string; hasConfigurationFile: boolean }): string {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_CONFIGURATION_REL_PATH);
  const action = params.hasConfigurationFile ? 'Edit' : 'Create';
  return (
    `${action} ${filePathAbs} to configure 'resolutionStrategy'. ` +
    `Default local root is 'dominds-apps' (rtws-relative) and expects local apps at '<root>/<appId>/'.`
  );
}

async function resolveLocalAppPackageRootAbs(params: {
  rtwsRootAbs: string;
  appId: string;
  localRoots: ReadonlyArray<string>;
  previousResolutionEntry: AppsResolutionEntry | null;
}): Promise<string | null> {
  const candidates = new Set<string>();
  if (params.previousResolutionEntry?.source.kind === 'local') {
    candidates.add(params.previousResolutionEntry.source.pathAbs);
  }
  for (const root of params.localRoots) {
    const rootAbs = path.isAbsolute(root) ? root : path.resolve(params.rtwsRootAbs, root);
    candidates.add(path.resolve(rootAbs, params.appId));
  }
  for (const candidateAbs of candidates) {
    if (await dirExists(candidateAbs)) return candidateAbs;
  }
  return null;
}

async function loadManifestDepsFromResolvedApp(params: {
  appId: string;
  packageRootAbs: string;
}): Promise<ReadonlyArray<DomindsAppDependency>> {
  const pkgInfo = await readPackageInfo({ packageRootAbs: params.packageRootAbs });
  const loaded = await loadDomindsAppManifest({
    packageRootAbs: params.packageRootAbs,
    manifestRelPath: pkgInfo.manifestRelPath,
  });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to load app manifest for '${params.appId}': ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }
  return loaded.manifest.dependencies ?? [];
}

function makeLockedAppHint(entry: AppLockEntry): LockedAppHint {
  return {
    packageName: entry.package.name,
    version: entry.package.version,
  };
}

function buildNpxSpec(params: {
  appId: string;
  lockedHint: LockedAppHint | null;
  previousResolutionEntry: AppsResolutionEntry | null;
}): string {
  const packageName =
    params.lockedHint?.packageName ??
    params.previousResolutionEntry?.installJson.package.name ??
    params.appId;
  const version = params.lockedHint?.version ?? null;
  return version && version.trim() !== '' ? `${packageName}@${version}` : packageName;
}

async function probeAppByStrategy(params: {
  rtwsRootAbs: string;
  appId: string;
  strategy: NormalizedAppsResolutionStrategy;
  lockedHint: LockedAppHint | null;
  previousResolutionEntry: AppsResolutionEntry | null;
}): Promise<ResolvedAppProbe | null> {
  for (const item of params.strategy.order) {
    if (item === 'local') {
      const packageRootAbs = await resolveLocalAppPackageRootAbs({
        rtwsRootAbs: params.rtwsRootAbs,
        appId: params.appId,
        localRoots: params.strategy.localRoots,
        previousResolutionEntry: params.previousResolutionEntry,
      });
      if (!packageRootAbs) continue;

      const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs });
      if (installJson.appId !== params.appId) {
        throw new Error(
          `App id mismatch for local package '${packageRootAbs}': expected '${params.appId}', got '${installJson.appId}'`,
        );
      }
      return { source: { kind: 'local', pathAbs: packageRootAbs }, installJson };
    }

    if (item === 'npx') {
      const spec = buildNpxSpec({
        appId: params.appId,
        lockedHint: params.lockedHint,
        previousResolutionEntry: params.previousResolutionEntry,
      });
      const installJson = await runDomindsAppJsonViaNpx({
        spec,
        cwdAbs: params.rtwsRootAbs,
      });
      if (installJson.appId !== params.appId) {
        throw new Error(
          `App id mismatch for npx '${spec}': expected '${params.appId}', got '${installJson.appId}'`,
        );
      }
      return { source: { kind: 'npx', spec }, installJson };
    }

    const exhaustive: never = item;
    throw new Error(`Unreachable resolution strategy item: ${String(exhaustive)}`);
  }
  return null;
}

function makeResolutionEntry(params: {
  appId: string;
  probe: ResolvedAppProbe;
  cachedAssignedPort: number | null;
}): AppsResolutionEntry {
  return {
    id: params.appId,
    enabled: true,
    source: params.probe.source,
    assignedPort: params.cachedAssignedPort,
    installJson: params.probe.installJson,
  };
}

async function resolveGraph(params: {
  rtwsRootAbs: string;
  strategy: NormalizedAppsResolutionStrategy;
  configurationDisabledApps: ReadonlySet<string>;
  previousResolutionById: ReadonlyMap<string, AppsResolutionEntry>;
  lockedHintsById: ReadonlyMap<string, LockedAppHint>;
  hasConfigurationFile: boolean;
}): Promise<ResolvedGraphState> {
  type DepEdge = Readonly<{ depId: string; required: boolean }>;

  const issues: AppsResolutionIssue[] = [];
  const resolvedById = new Map<string, AppsResolutionEntry>();
  const depsByAppId = new Map<string, ReadonlyArray<DepEdge>>();
  const fatalApps = new Set<string>();
  const requiredById = new Map<string, boolean>();
  const requiredByParents = new Map<string, Set<string>>();
  const queue: string[] = [];

  const pushIssue = (issue: AppsResolutionIssue): void => {
    issues.push(issue);
  };

  const addRequiredByParent = (depId: string, parentId: string): void => {
    const existing = requiredByParents.get(depId);
    if (existing) {
      existing.add(parentId);
      return;
    }
    requiredByParents.set(depId, new Set([parentId]));
  };

  const mergeRequiredFlag = (id: string, required: boolean): boolean => {
    const prev = requiredById.get(id);
    if (prev === undefined) {
      requiredById.set(id, required);
      return true;
    }
    if (prev === true || required === false) return false;
    requiredById.set(id, true);
    return true;
  };

  const enqueue = (id: string, required: boolean, parentId: string | null): void => {
    const changed = mergeRequiredFlag(id, required);
    if (required && parentId) addRequiredByParent(id, parentId);
    if (changed) queue.push(id);
  };

  try {
    const rootDeps = await loadRtwsDeclaredAppDependencies({ rtwsRootAbs: params.rtwsRootAbs });
    for (const dep of rootDeps) {
      enqueue(dep.id, dep.optional !== true, 'rtws');
    }
  } catch (err: unknown) {
    pushIssue({
      kind: 'app_manifest_load_failed',
      severity: 'error',
      message:
        'Failed to load rtws app manifest (.minds/app.yaml); app dependencies will not be resolved.',
      detail: {
        appId: 'rtws',
        manifestRelPath: '.minds/app.yaml',
        errorText: err instanceof Error ? err.message : String(err),
      },
    });
  }

  while (queue.length > 0) {
    const appId = queue.shift();
    if (!appId) break;
    if (resolvedById.has(appId) || fatalApps.has(appId)) continue;

    const required = requiredById.get(appId) ?? true;
    const explicitlyDisabled = params.configurationDisabledApps.has(appId);
    const previousResolutionEntry = params.previousResolutionById.get(appId) ?? null;

    let probe: ResolvedAppProbe | null = null;
    try {
      probe = await probeAppByStrategy({
        rtwsRootAbs: params.rtwsRootAbs,
        appId,
        strategy: params.strategy,
        lockedHint: params.lockedHintsById.get(appId) ?? null,
        previousResolutionEntry,
      });
    } catch (err: unknown) {
      if (required) {
        const roots = params.strategy.localRoots
          .map((root) => (path.isAbsolute(root) ? root : path.resolve(params.rtwsRootAbs, root)))
          .join(', ');
        pushIssue({
          kind: explicitlyDisabled ? 'required_dependency_disabled' : 'required_dependency_missing',
          severity: 'error',
          message: explicitlyDisabled
            ? `Required app dependency '${appId}' is disabled.`
            : `Required app dependency '${appId}' failed to resolve.`,
          detail: {
            appId,
            searchedLocalRootsAbs: roots,
            hint: getResolutionHint({
              rtwsRootAbs: params.rtwsRootAbs,
              hasConfigurationFile: params.hasConfigurationFile,
            }),
            errorText: err instanceof Error ? err.message : String(err),
            requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
          },
        });
      }
      continue;
    }

    if (!probe) {
      if (required) {
        const roots = params.strategy.localRoots
          .map((root) => (path.isAbsolute(root) ? root : path.resolve(params.rtwsRootAbs, root)))
          .join(', ');
        pushIssue({
          kind: explicitlyDisabled ? 'required_dependency_disabled' : 'required_dependency_missing',
          severity: 'error',
          message: explicitlyDisabled
            ? `Required app dependency '${appId}' is disabled.`
            : `Required app dependency '${appId}' is missing.`,
          detail: {
            appId,
            searchedLocalRootsAbs: roots,
            hint: getResolutionHint({
              rtwsRootAbs: params.rtwsRootAbs,
              hasConfigurationFile: params.hasConfigurationFile,
            }),
            requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
          },
        });
      }
      continue;
    }

    const entry = makeResolutionEntry({
      appId,
      probe,
      cachedAssignedPort: previousResolutionEntry?.assignedPort ?? null,
    });
    resolvedById.set(appId, entry);

    if (explicitlyDisabled) {
      if (required) {
        pushIssue({
          kind: 'required_dependency_disabled',
          severity: 'error',
          message: `Required app dependency '${appId}' is disabled.`,
          detail: {
            appId,
            configurationFileRelPath: APPS_CONFIGURATION_REL_PATH,
            requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
          },
        });
      }
      continue;
    }

    let manifestDeps: ReadonlyArray<DomindsAppDependency>;
    try {
      manifestDeps = await loadManifestDepsFromResolvedApp({
        appId,
        packageRootAbs: entry.installJson.package.rootAbs,
      });
    } catch (err: unknown) {
      pushIssue({
        kind: 'app_manifest_load_failed',
        severity: 'error',
        message: `Failed to load app manifest for '${appId}'.`,
        detail: {
          appId,
          packageRootAbs: entry.installJson.package.rootAbs,
          errorText: err instanceof Error ? err.message : String(err),
        },
      });
      fatalApps.add(appId);
      continue;
    }

    const edges: DepEdge[] = manifestDeps.map((dep) => ({
      depId: dep.id,
      required: dep.optional !== true,
    }));
    depsByAppId.set(appId, edges);
    for (const edge of edges) {
      enqueue(edge.depId, edge.required, appId);
    }
  }

  const effectiveEnabledById = new Map<string, boolean>();
  for (const [appId] of resolvedById.entries()) {
    effectiveEnabledById.set(
      appId,
      !params.configurationDisabledApps.has(appId) && !fatalApps.has(appId),
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [appId] of resolvedById.entries()) {
      if (!(effectiveEnabledById.get(appId) ?? false)) continue;
      const edges = depsByAppId.get(appId) ?? [];
      for (const edge of edges) {
        if (!edge.required) continue;

        const depResolved = resolvedById.get(edge.depId) ?? null;
        const depExplicitlyDisabled = params.configurationDisabledApps.has(edge.depId);
        const depEffectiveEnabled = depResolved
          ? (effectiveEnabledById.get(edge.depId) ?? false)
          : false;
        if (depExplicitlyDisabled || !depResolved || !depEffectiveEnabled) {
          effectiveEnabledById.set(appId, false);
          pushIssue({
            kind: 'app_effectively_disabled_due_to_required_dependency',
            severity: 'error',
            message: `App '${appId}' is effectively disabled due to missing/disabled required dependency '${edge.depId}'.`,
            detail: {
              appId,
              dependencyId: edge.depId,
              dependencyState: depExplicitlyDisabled
                ? 'disabled'
                : depResolved
                  ? 'effectively_disabled'
                  : 'missing',
            },
          });
          changed = true;
          break;
        }
      }
    }
  }

  const resolvedEntriesForPorts = [...resolvedById.values()];
  for (const [appId, entry] of resolvedById.entries()) {
    if (!(effectiveEnabledById.get(appId) ?? false)) continue;

    const assigned = await resolveStableAssignedPortWithReason({
      appId,
      installJson: entry.installJson,
      existingApps: resolvedEntriesForPorts,
      existingAssignedPort: entry.assignedPort,
    });

    if (assigned.assignedPort !== entry.assignedPort) {
      const nextEntry: AppsResolutionEntry = { ...entry, assignedPort: assigned.assignedPort };
      resolvedById.set(appId, nextEntry);
      const idx = resolvedEntriesForPorts.findIndex((item) => item.id === appId);
      if (idx >= 0) resolvedEntriesForPorts[idx] = nextEntry;
    }

    if (
      assigned.reason === 'reassigned_from_existing_conflict' ||
      assigned.reason === 'reassigned_from_existing_unbindable'
    ) {
      pushIssue({
        kind: 'assigned_port_reassigned',
        severity: 'warning',
        message: `App '${appId}' assignedPort was reassigned due to runtime port conflict.`,
        detail: {
          appId,
          previousAssignedPort: entry.assignedPort,
          reassignedToPort: assigned.assignedPort,
          reason: assigned.reason,
          resolutionFileRelPath: APPS_RESOLUTION_REL_PATH,
        },
      });
    }
  }

  const apps: AppsResolutionEntry[] = [];
  for (const [appId, entry] of resolvedById.entries()) {
    apps.push({ ...entry, enabled: effectiveEnabledById.get(appId) ?? false });
  }

  return {
    resolutionFile: { schemaVersion: 1, apps },
    issues,
  };
}

export async function materializeAppsResolution(params: {
  rtwsRootAbs: string;
}): Promise<ResolvedGraphState> {
  const loadedConfig = await loadAppsConfigurationFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedConfig.kind === 'error') {
    throw new Error(
      `Failed to load apps configuration: ${loadedConfig.errorText} (${loadedConfig.filePathAbs})`,
    );
  }

  const loadedResolution = await loadAppsResolutionFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedResolution.kind === 'error') {
    throw new Error(
      `Failed to load apps resolution snapshot: ${loadedResolution.errorText} (${loadedResolution.filePathAbs})`,
    );
  }

  const loadedLock = await loadAppLockFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loadedLock.kind === 'error') {
    throw new Error(`Failed to load app lock: ${loadedLock.errorText} (${loadedLock.filePathAbs})`);
  }

  const previousResolutionById = new Map<string, AppsResolutionEntry>();
  for (const entry of loadedResolution.file.apps) {
    previousResolutionById.set(entry.id, entry);
  }

  const lockedHintsById = new Map<string, LockedAppHint>();
  for (const entry of loadedLock.file.apps) {
    lockedHintsById.set(entry.id, makeLockedAppHint(entry));
  }

  const resolved = await resolveGraph({
    rtwsRootAbs: params.rtwsRootAbs,
    strategy: normalizeStrategy(loadedConfig.file.resolutionStrategy),
    configurationDisabledApps: new Set(loadedConfig.file.disabledApps ?? []),
    previousResolutionById,
    lockedHintsById,
    hasConfigurationFile: loadedConfig.exists,
  });

  if (JSON.stringify(loadedResolution.file) !== JSON.stringify(resolved.resolutionFile)) {
    await writeAppsResolutionFileIfChanged({
      rtwsRootAbs: params.rtwsRootAbs,
      file: resolved.resolutionFile,
    });
  }

  return resolved;
}

export async function loadEnabledAppsSnapshot(params: {
  rtwsRootAbs: string;
}): Promise<EnabledAppsSnapshot> {
  const resolved = await materializeAppsResolution({ rtwsRootAbs: params.rtwsRootAbs });
  return {
    enabledApps: resolved.resolutionFile.apps
      .filter((app) => app.enabled)
      .map((app) => ({
        id: app.id,
        runtimePort: getRuntimePort(app),
        installJson: app.installJson,
        source: app.source,
      })),
    issues: resolved.issues,
  };
}
