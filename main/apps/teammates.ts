import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { loadEnabledAppsSnapshot } from './enabled-apps';
import { loadDomindsAppManifest } from './manifest';
import { resolveAppOverrideFileAbs } from './override-paths';
import { readPackageInfo } from './package-info';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type AppTeammatesSnippet = Readonly<{
  appId: string;
  members: Record<string, unknown>;
}>;

type OverrideOwner = Readonly<{ appId: string; packageRootAbs: string }>;

type EnabledAppForTeammates = Readonly<{
  id: string;
  packageRootAbs: string;
}>;

async function loadEnabledAppDependencyGraph(params: {
  enabledApps: ReadonlyArray<EnabledAppForTeammates>;
}): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const enabledIds = new Set(params.enabledApps.map((app) => app.id));
  const out = new Map<string, ReadonlySet<string>>();

  for (const app of params.enabledApps) {
    try {
      const pkgInfo = await readPackageInfo({ packageRootAbs: app.packageRootAbs });
      const loaded = await loadDomindsAppManifest({
        packageRootAbs: app.packageRootAbs,
        manifestRelPath: pkgInfo.manifestRelPath,
      });
      if (loaded.kind !== 'ok') {
        out.set(app.id, new Set());
        continue;
      }
      const deps = new Set<string>();
      for (const dep of loaded.manifest.dependencies ?? []) {
        const depId = dep.id.trim();
        if (depId === '' || !enabledIds.has(depId)) continue;
        deps.add(depId);
      }
      out.set(app.id, deps);
    } catch {
      // Fail-open for override owner discovery: unresolved owner deps just don't contribute overrides.
      out.set(app.id, new Set());
    }
  }

  return out;
}

function computeOverrideOwnersByTarget(params: {
  enabledApps: ReadonlyArray<EnabledAppForTeammates>;
  depGraphByOwner: ReadonlyMap<string, ReadonlySet<string>>;
}): ReadonlyMap<string, ReadonlyArray<OverrideOwner>> {
  const packageRootByAppId = new Map<string, string>();
  const ownersByDep = new Map<string, string[]>();
  for (const app of params.enabledApps) {
    packageRootByAppId.set(app.id, app.packageRootAbs);
  }
  for (const [ownerId, depIds] of params.depGraphByOwner.entries()) {
    for (const depId of depIds) {
      const owners = ownersByDep.get(depId);
      if (owners) {
        owners.push(ownerId);
      } else {
        ownersByDep.set(depId, [ownerId]);
      }
    }
  }

  const result = new Map<string, ReadonlyArray<OverrideOwner>>();
  for (const targetApp of params.enabledApps) {
    const targetId = targetApp.id;
    const depthByOwner = new Map<string, number>();
    const queue: Array<Readonly<{ ownerId: string; depth: number }>> = [];

    for (const ownerId of ownersByDep.get(targetId) ?? []) {
      if (ownerId === targetId) continue;
      depthByOwner.set(ownerId, 1);
      queue.push({ ownerId, depth: 1 });
    }

    // Use shortest dependency distance from target to owner so traversal remains bounded
    // even when enabled apps contain dependency cycles.
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      const nextOwners = ownersByDep.get(current.ownerId) ?? [];
      for (const nextOwnerId of nextOwners) {
        if (nextOwnerId === targetId) continue;
        const nextDepth = current.depth + 1;
        const prevDepth = depthByOwner.get(nextOwnerId);
        if (prevDepth !== undefined && prevDepth <= nextDepth) continue;
        depthByOwner.set(nextOwnerId, nextDepth);
        queue.push({ ownerId: nextOwnerId, depth: nextDepth });
      }
    }

    const owners = [...depthByOwner.entries()]
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .map(([ownerId]) => {
        const packageRootAbs = packageRootByAppId.get(ownerId);
        if (!packageRootAbs) return null;
        return { appId: ownerId, packageRootAbs };
      })
      .filter((owner): owner is OverrideOwner => owner !== null);

    result.set(targetId, owners);
  }

  return result;
}

export async function loadEnabledAppTeammates(params: {
  rtwsRootAbs: string;
}): Promise<ReadonlyArray<AppTeammatesSnippet>> {
  const snap = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  const enabledApps: EnabledAppForTeammates[] = snap.enabledApps.map((app) => ({
    id: app.id,
    packageRootAbs: app.installJson.package.rootAbs,
  }));
  const depGraphByOwner = await loadEnabledAppDependencyGraph({ enabledApps });
  const overrideOwnersByTarget = computeOverrideOwnersByTarget({ enabledApps, depGraphByOwner });

  const out: AppTeammatesSnippet[] = [];
  for (const app of snap.enabledApps) {
    const rel = app.installJson.contributes?.teammatesYamlRelPath;
    if (!rel) continue;

    const appOverrideOwners = overrideOwnersByTarget.get(app.id) ?? [];

    // Priority: rtws override > app override (integrator-provided) > app defaults.
    const override = await resolveAppOverrideFileAbs({
      rtwsRootAbs: params.rtwsRootAbs,
      appId: app.id,
      appRelPath: rel,
      appOverrideOwners,
    });
    const filePathAbs =
      override.kind === 'found'
        ? override.filePathAbs
        : path.resolve(app.installJson.package.rootAbs, rel);
    const raw = await fs.readFile(filePathAbs, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Invalid app teammates yaml: expected object (${app.id} at ${filePathAbs})`);
    }
    const keys = Object.keys(parsed);
    for (const k of keys) {
      if (k !== 'members') {
        throw new Error(
          `Invalid app teammates yaml: unknown top-level key '${k}' (only 'members' allowed) (${app.id} at ${filePathAbs})`,
        );
      }
    }
    const membersRaw = parsed['members'];
    if (membersRaw === undefined) {
      out.push({ appId: app.id, members: {} });
      continue;
    }
    if (!isRecord(membersRaw)) {
      throw new Error(
        `Invalid app teammates yaml: members must be an object (${app.id} at ${filePathAbs})`,
      );
    }
    out.push({ appId: app.id, members: membersRaw });
  }
  return out;
}
