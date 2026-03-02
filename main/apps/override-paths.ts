import fs from 'fs/promises';
import path from 'path';

type OverrideFileResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'found'; filePathAbs: string; source: 'override' | 'legacy_override' }>;

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
 * Resolve a workspace override file path for a given app-relative file path.
 *
 * Priority order (read-time):
 * 1) `<rtws>/.apps/override/<app-id>/<rel>`
 * 2) `<rtws>/.apps/<app-id>/<rel>` (legacy)
 */
export async function resolveAppOverrideFileAbs(params: {
  rtwsRootAbs: string;
  appId: string;
  appRelPath: string;
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
    return { kind: 'found', filePathAbs: preferredAbs, source: 'override' };
  }

  const legacyAbs = path.resolve(params.rtwsRootAbs, '.apps', params.appId, normalized);
  if (await isRegularFile(legacyAbs)) {
    return { kind: 'found', filePathAbs: legacyAbs, source: 'legacy_override' };
  }

  return { kind: 'none' };
}
