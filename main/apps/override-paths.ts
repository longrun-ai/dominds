import fs from 'fs/promises';
import path from 'path';

type OverrideFileResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'found';
      filePathAbs: string;
      source: 'rtws_override' | 'app_override';
      ownerAppId: string | null;
    }>;

function normalizeRelNoTraversal(rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) return null;
  return normalized;
}

async function isRegularFile(filePathAbs: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePathAbs);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an app asset override file path for a given app-relative file path.
 *
 * Priority order (read-time):
 * 1) `<rtws>/.apps/override/<app-id>/<rel>`
 * 2) `<integrator-app-root>/.apps/override/<app-id>/<rel>` (in provided order)
 */
export async function resolveAppOverrideFileAbs(params: {
  rtwsRootAbs: string;
  appId: string;
  appRelPath: string;
  appOverrideOwners?: ReadonlyArray<Readonly<{ appId: string; packageRootAbs: string }>>;
}): Promise<OverrideFileResolution> {
  const normalized = normalizeRelNoTraversal(params.appRelPath);
  if (!normalized) return { kind: 'none' };

  const preferredAbs = path.resolve(
    params.rtwsRootAbs,
    '.apps',
    'override',
    params.appId,
    normalized,
  );
  if (await isRegularFile(preferredAbs)) {
    return {
      kind: 'found',
      filePathAbs: preferredAbs,
      source: 'rtws_override',
      ownerAppId: null,
    };
  }

  const owners = params.appOverrideOwners ?? [];
  for (const owner of owners) {
    const candidateAbs = path.resolve(
      owner.packageRootAbs,
      '.apps',
      'override',
      params.appId,
      normalized,
    );
    if (await isRegularFile(candidateAbs)) {
      return {
        kind: 'found',
        filePathAbs: candidateAbs,
        source: 'app_override',
        ownerAppId: owner.appId,
      };
    }
  }

  return { kind: 'none' };
}
