import fs from 'node:fs/promises';
import path from 'node:path';

import type { AppsResolutionEntry } from './resolution-file';

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

export async function resolveLocalAppPackageRootAbs(params: {
  rtwsRootAbs: string;
  appId: string;
  localRoots: ReadonlyArray<string>;
  previousResolutionEntry: AppsResolutionEntry | null;
}): Promise<string | null> {
  const candidates = new Set<string>();
  const trimmedAppId = params.appId.trim();
  if (trimmedAppId === '') return null;

  if (params.previousResolutionEntry?.source.kind === 'local') {
    candidates.add(params.previousResolutionEntry.source.pathAbs);
  }
  for (const root of params.localRoots) {
    const rootAbs = path.isAbsolute(root) ? root : path.resolve(params.rtwsRootAbs, root);
    candidates.add(path.resolve(rootAbs, trimmedAppId));
  }
  for (const candidateAbs of candidates) {
    if (await dirExists(candidateAbs)) return candidateAbs;
  }
  return null;
}
