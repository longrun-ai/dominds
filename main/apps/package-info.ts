import fs from 'fs/promises';
import path from 'path';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type PackageInfo = Readonly<{
  packageName: string | null;
  packageVersion: string | null;
  manifestRelPath: string;
}>;

export async function readPackageInfo(params: { packageRootAbs: string }): Promise<PackageInfo> {
  const fallback: PackageInfo = {
    packageName: null,
    packageVersion: null,
    manifestRelPath: 'dominds.app.yaml',
  };
  const pkgJsonAbs = path.resolve(params.packageRootAbs, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(pkgJsonAbs, 'utf-8');
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) return fallback;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;

  const name = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
  const version = typeof parsed['version'] === 'string' ? parsed['version'].trim() : '';

  let manifestRelPath = 'dominds.app.yaml';
  const dominds = parsed['dominds'];
  if (isRecord(dominds)) {
    const mr = typeof dominds['appManifest'] === 'string' ? dominds['appManifest'].trim() : '';
    if (mr !== '') manifestRelPath = mr;
  }

  return {
    packageName: name !== '' ? name : null,
    packageVersion: version !== '' ? version : null,
    manifestRelPath,
  };
}
