import fs from 'node:fs/promises';
import path from 'node:path';

import type { DomindsAppInstallJsonV1 } from './app-json';
import { resolveStableAssignedPortWithReason } from './assigned-port';
import type { DomindsAppDependency } from './manifest';
import { loadDomindsAppManifest } from './manifest';
import { readPackageInfo } from './package-info';
import {
  APPS_RESOLUTION_REL_PATH,
  DEFAULT_APPS_RESOLUTION_STRATEGY,
  applyAssignedPortToResolvedApps,
  applyEffectiveEnabledToResolvedApps,
  loadAppsResolutionFile,
  writeAppsResolutionFileIfChanged,
  type AppsResolutionEntry,
  type AppsResolutionFile,
  type AppsResolutionSource,
  type AppsResolutionStrategy,
  type AppsResolutionStrategyOrderItem,
} from './resolution-file';
import { runDomindsAppJsonViaLocalPackage } from './run-app-json';

export type EnabledAppSnapshotEntry = Readonly<{
  id: string;
  runtimePort: number | null;
  installJson: DomindsAppInstallJsonV1;
  source: AppsResolutionEntry['source'];
}>;

export type EnabledAppsSnapshot = Readonly<{
  enabledApps: ReadonlyArray<EnabledAppSnapshotEntry>;
  issues: ReadonlyArray<AppsResolutionIssue>;
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

type AppsResolutionOverlayIndex = Readonly<{
  byId: ReadonlyMap<string, AppsResolutionEntry>;
  extras: ReadonlyArray<AppsResolutionEntry>;
}>;

type NormalizedAppsResolutionStrategy = Readonly<{
  order: ReadonlyArray<AppsResolutionStrategyOrderItem>;
  localRoots: ReadonlyArray<string>;
}>;

async function fileExists(filePathAbs: string): Promise<boolean> {
  try {
    await fs.access(filePathAbs);
    return true;
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

async function dirExists(dirPathAbs: string): Promise<boolean> {
  try {
    const st = await fs.stat(dirPathAbs);
    return st.isDirectory();
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

async function tryLoadRtwsAppManifestDeps(params: {
  rtwsRootAbs: string;
}): Promise<ReadonlyArray<DomindsAppDependency>> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, '.minds', 'app.yaml');
  if (!(await fileExists(filePathAbs))) return [];

  const loaded = await loadDomindsAppManifest({
    packageRootAbs: params.rtwsRootAbs,
    manifestRelPath: '.minds/app.yaml',
  });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to load rtws app manifest: ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }
  return loaded.manifest.dependencies ?? [];
}

function indexOverlayApps(params: {
  overlayApps: ReadonlyArray<AppsResolutionEntry>;
}): AppsResolutionOverlayIndex {
  const byId = new Map<string, AppsResolutionEntry>();
  const extras: AppsResolutionEntry[] = [];
  for (const e of params.overlayApps) {
    if (byId.has(e.id)) {
      // Loud: duplicate IDs means non-deterministic overrides.
      throw new Error(`Invalid apps resolution overlay: duplicate app id '${e.id}'`);
    }
    byId.set(e.id, e);
    extras.push(e);
  }
  return { byId, extras };
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
      `Invalid ${APPS_RESOLUTION_REL_PATH}: resolutionStrategy.order must not be empty`,
    );
  }
  if (localRoots.length === 0) {
    throw new Error(
      `Invalid ${APPS_RESOLUTION_REL_PATH}: resolutionStrategy.localRoots must not be empty`,
    );
  }

  const orderSet = new Set(order);
  if (orderSet.size !== order.length) {
    throw new Error(`Invalid ${APPS_RESOLUTION_REL_PATH}: resolutionStrategy.order has duplicates`);
  }
  const localRootsSet = new Set(localRoots);
  if (localRootsSet.size !== localRoots.length) {
    throw new Error(
      `Invalid ${APPS_RESOLUTION_REL_PATH}: resolutionStrategy.localRoots has duplicates`,
    );
  }

  return { order, localRoots };
}

function getResolutionHint(params: { rtwsRootAbs: string; hasResolutionFile: boolean }): string {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const action = params.hasResolutionFile ? 'Edit' : 'Create';
  return (
    `${action} ${filePathAbs} to configure 'resolutionStrategy'. ` +
    `Default local root is 'dominds-apps' (rtws-relative) and expects local apps at '<root>/<appId>/'.`
  );
}

async function resolveLocalAppPackageRootAbs(params: {
  rtwsRootAbs: string;
  appId: string;
  localRoots: ReadonlyArray<string>;
}): Promise<string | null> {
  for (const root of params.localRoots) {
    const rootAbs = path.isAbsolute(root) ? root : path.resolve(params.rtwsRootAbs, root);
    const candidateAbs = path.resolve(rootAbs, params.appId);
    if (await dirExists(candidateAbs)) return candidateAbs;
  }
  return null;
}

async function resolveAppManifestDepsFromInstalledApp(params: {
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

async function resolveAppsFromRtwsHierarchy(params: {
  rtwsRootAbs: string;
  overlay: AppsResolutionOverlayIndex;
  strategy: NormalizedAppsResolutionStrategy;
  hasResolutionFile: boolean;
}): Promise<
  Readonly<{
    apps: ReadonlyArray<AppsResolutionEntry>;
    issues: ReadonlyArray<AppsResolutionIssue>;
    effectiveEnabledById: ReadonlyMap<string, boolean>;
    assignedPortById: ReadonlyMap<string, number | null>;
  }>
> {
  type DepEdge = Readonly<{ depId: string; required: boolean }>;

  const issues: AppsResolutionIssue[] = [];
  const pushIssue = (issue: AppsResolutionIssue): void => {
    issues.push(issue);
  };

  const resolvedById = new Map<string, AppsResolutionEntry>();
  const depsByAppId = new Map<string, ReadonlyArray<DepEdge>>();
  const requiredById = new Map<string, boolean>();
  const requiredByParents = new Map<string, Set<string>>();
  const missingRequired = new Set<string>();
  const fatalApps = new Set<string>();

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
    if (prev === true) return false;
    if (required === true) {
      requiredById.set(id, true);
      return true;
    }
    return false;
  };

  const queue: string[] = [];
  const enqueue = (id: string, required: boolean, parentId: string | null): void => {
    const changed = mergeRequiredFlag(id, required);
    if (parentId && required) addRequiredByParent(id, parentId);
    if (changed) queue.push(id);
  };

  try {
    const rootDeps = await tryLoadRtwsAppManifestDeps({ rtwsRootAbs: params.rtwsRootAbs });
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
  // Also treat explicitly enabled overlay apps as roots so their own transitive dependencies
  // are resolved and missing-required issues can be surfaced.
  for (const e of params.overlay.extras) {
    if (!e.userEnabled) continue;
    enqueue(e.id, true, 'resolution_overlay');
  }

  const resolveMissingApp = async (appId: string): Promise<AppsResolutionEntry | null> => {
    for (const item of params.strategy.order) {
      if (item === 'local') {
        const packageRootAbs = await resolveLocalAppPackageRootAbs({
          rtwsRootAbs: params.rtwsRootAbs,
          appId,
          localRoots: params.strategy.localRoots,
        });
        if (!packageRootAbs) {
          continue;
        }
        const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs });
        if (installJson.appId !== appId) {
          throw new Error(
            `App id mismatch for local package '${packageRootAbs}': expected '${appId}', got '${installJson.appId}'`,
          );
        }
        const source: AppsResolutionSource = { kind: 'local', pathAbs: packageRootAbs };
        return {
          id: appId,
          enabled: true,
          userEnabled: true,
          source,
          assignedPort: null,
          installJson,
        };
      }
      if (item === 'npx') {
        throw new Error(
          `Apps resolution strategy 'npx' is not supported yet for missing app '${appId}'. ` +
            `Install it explicitly so it appears in ${APPS_RESOLUTION_REL_PATH}.`,
        );
      }
      const _exhaustive: never = item;
      throw new Error(`Unreachable: unknown resolution strategy item: ${String(_exhaustive)}`);
    }
    return null;
  };

  while (queue.length > 0) {
    const appId = queue.shift();
    if (!appId) break;

    if (resolvedById.has(appId) || missingRequired.has(appId) || fatalApps.has(appId)) {
      continue;
    }

    const required = requiredById.get(appId) ?? true;

    const overlayEntry = params.overlay.byId.get(appId) ?? null;
    let entry: AppsResolutionEntry | null = overlayEntry;
    if (!entry) {
      try {
        entry = await resolveMissingApp(appId);
      } catch (err: unknown) {
        if (required) {
          const roots = params.strategy.localRoots
            .map((r) => (path.isAbsolute(r) ? r : path.resolve(params.rtwsRootAbs, r)))
            .join(', ');
          pushIssue({
            kind: 'required_dependency_missing',
            severity: 'error',
            message: `Required app dependency '${appId}' failed to resolve.`,
            detail: {
              appId,
              searchedLocalRootsAbs: roots,
              hint: getResolutionHint({
                rtwsRootAbs: params.rtwsRootAbs,
                hasResolutionFile: params.hasResolutionFile,
              }),
              errorText: err instanceof Error ? err.message : String(err),
              requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
            },
          });
          missingRequired.add(appId);
        }
        continue;
      }
    }

    if (!entry) {
      if (required) {
        const roots = params.strategy.localRoots
          .map((r) => (path.isAbsolute(r) ? r : path.resolve(params.rtwsRootAbs, r)))
          .join(', ');
        pushIssue({
          kind: 'required_dependency_missing',
          severity: 'error',
          message: `Required app dependency '${appId}' is missing.`,
          detail: {
            appId,
            searchedLocalRootsAbs: roots,
            hint: getResolutionHint({
              rtwsRootAbs: params.rtwsRootAbs,
              hasResolutionFile: params.hasResolutionFile,
            }),
            requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
          },
        });
        missingRequired.add(appId);
      }
      continue;
    }

    resolvedById.set(appId, entry);

    if (!entry.userEnabled) {
      if (required) {
        pushIssue({
          kind: 'required_dependency_disabled',
          severity: 'error',
          message: `Required app dependency '${appId}' is disabled.`,
          detail: {
            appId,
            resolutionFileRelPath: APPS_RESOLUTION_REL_PATH,
            requiredBy: [...(requiredByParents.get(appId) ?? new Set<string>())].sort(),
            hint: getResolutionHint({
              rtwsRootAbs: params.rtwsRootAbs,
              hasResolutionFile: params.hasResolutionFile,
            }),
          },
        });
      }
      continue;
    }

    let manifestDeps: ReadonlyArray<DomindsAppDependency>;
    try {
      manifestDeps = await resolveAppManifestDepsFromInstalledApp({
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

    const edges: DepEdge[] = manifestDeps.map((d) => ({
      depId: d.id,
      required: d.optional !== true,
    }));
    depsByAppId.set(appId, edges);
    for (const e of edges) {
      enqueue(e.depId, e.required, appId);
    }
  }

  const effectiveEnabledById = new Map<string, boolean>();
  for (const [id, entry] of resolvedById.entries()) {
    effectiveEnabledById.set(id, entry.userEnabled && !fatalApps.has(id));
  }

  // Fixed-point disable propagation: if an enabled app has a required dependency that is missing
  // or effectively disabled, the app becomes effectively disabled.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [appId, entry] of resolvedById.entries()) {
      if (!effectiveEnabledById.get(appId)) continue;
      if (!entry.userEnabled) continue;
      const edges = depsByAppId.get(appId) ?? [];
      for (const edge of edges) {
        if (!edge.required) continue;
        const depId = edge.depId;
        const depResolved = resolvedById.get(depId) ?? null;
        const depEnabled = depResolved ? (effectiveEnabledById.get(depId) ?? false) : false;
        const depMissing = !depResolved && missingRequired.has(depId);
        if (depMissing || !depEnabled) {
          effectiveEnabledById.set(appId, false);
          pushIssue({
            kind: 'app_effectively_disabled_due_to_required_dependency',
            severity: 'error',
            message: `App '${appId}' is effectively disabled due to missing/disabled required dependency '${depId}'.`,
            detail: {
              appId,
              dependencyId: depId,
              dependencyState: depMissing
                ? 'missing'
                : depResolved && depResolved.userEnabled === false
                  ? 'disabled'
                  : 'effectively_disabled',
            },
          });
          changed = true;
          break;
        }
      }
    }
  }

  const assignedPortById = new Map<string, number | null>();
  const resolvedEntriesForPort = [...resolvedById.values()];
  for (const [appId, entry] of resolvedById.entries()) {
    if (!effectiveEnabledById.get(appId)) continue;
    const assigned = await resolveStableAssignedPortWithReason({
      appId,
      installJson: entry.installJson,
      existingApps: resolvedEntriesForPort,
      existingAssignedPort: entry.assignedPort,
    });
    assignedPortById.set(appId, assigned.assignedPort);

    if (assigned.assignedPort !== entry.assignedPort) {
      const nextEntry: AppsResolutionEntry = { ...entry, assignedPort: assigned.assignedPort };
      resolvedById.set(appId, nextEntry);
      const idx = resolvedEntriesForPort.findIndex((a) => a.id === appId);
      if (idx >= 0) {
        resolvedEntriesForPort[idx] = nextEntry;
      }
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

  const out: AppsResolutionEntry[] = [];
  for (const [appId, entry] of resolvedById.entries()) {
    if (!effectiveEnabledById.get(appId)) continue;
    out.push(entry.enabled ? entry : { ...entry, enabled: true });
  }

  return { apps: out, issues, effectiveEnabledById, assignedPortById };
}

async function loadAppsResolutionOverlay(params: { rtwsRootAbs: string }): Promise<
  Readonly<{
    overlay: AppsResolutionOverlayIndex;
    resolutionFile: AppsResolutionFile;
    strategy: NormalizedAppsResolutionStrategy;
    hasResolutionFile: boolean;
  }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const hasResolutionFile = await fileExists(filePathAbs);
  if (!hasResolutionFile) {
    const emptyFile: AppsResolutionFile = { schemaVersion: 1, apps: [] };
    return {
      overlay: indexOverlayApps({ overlayApps: [] }),
      resolutionFile: emptyFile,
      strategy: normalizeStrategy(undefined),
      hasResolutionFile,
    };
  }
  const loaded = await loadAppsResolutionFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to load apps resolution file overlay: ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }

  return {
    overlay: indexOverlayApps({ overlayApps: loaded.file.apps }),
    resolutionFile: loaded.file,
    strategy: normalizeStrategy(loaded.file.resolutionStrategy),
    hasResolutionFile,
  };
}

async function loadEffectiveAppsResolution(params: {
  rtwsRootAbs: string;
}): Promise<
  Readonly<{ apps: ReadonlyArray<AppsResolutionEntry>; issues: ReadonlyArray<AppsResolutionIssue> }>
> {
  const loaded = await loadAppsResolutionOverlay({ rtwsRootAbs: params.rtwsRootAbs });
  const resolved = await resolveAppsFromRtwsHierarchy({
    rtwsRootAbs: params.rtwsRootAbs,
    overlay: loaded.overlay,
    strategy: loaded.strategy,
    hasResolutionFile: loaded.hasResolutionFile,
  });

  if (loaded.hasResolutionFile) {
    const withEffectiveEnabled = applyEffectiveEnabledToResolvedApps({
      existing: loaded.resolutionFile,
      effectiveEnabledById: resolved.effectiveEnabledById,
    });
    const nextResolutionFile = applyAssignedPortToResolvedApps({
      existing: withEffectiveEnabled,
      assignedPortById: resolved.assignedPortById,
    });
    if (nextResolutionFile !== loaded.resolutionFile) {
      await writeAppsResolutionFileIfChanged({ rtwsRootAbs: params.rtwsRootAbs, file: nextResolutionFile });
    }
  }

  return { apps: resolved.apps, issues: resolved.issues };
}

export async function loadEnabledAppsSnapshot(params: {
  rtwsRootAbs: string;
}): Promise<EnabledAppsSnapshot> {
  const loaded = await loadEffectiveAppsResolution({ rtwsRootAbs: params.rtwsRootAbs });
  const enabledApps: EnabledAppSnapshotEntry[] = loaded.apps
    .filter((a) => a.enabled)
    .map((a) => ({
      // Note: installJson.frontend.defaultPort may be 0 (meaning "runtime decides"); do not pass 0 as runtimePort.
      id: a.id,
      runtimePort:
        a.assignedPort ??
        (a.installJson.frontend &&
        a.installJson.frontend.defaultPort &&
        a.installJson.frontend.defaultPort > 0
          ? a.installJson.frontend.defaultPort
          : null),
      installJson: a.installJson,
      source: a.source,
    }));
  return { enabledApps, issues: loaded.issues };
}
