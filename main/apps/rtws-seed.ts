import fs from 'fs/promises';
import path from 'path';

import type { DomindsAppManifest } from './manifest';

function ensureRelNoTraversal(rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/g, '');
  if (normalized.includes('..')) {
    throw new Error(`Invalid path contains '..': ${rel}`);
  }
  return normalized;
}

async function writeIfMissing(fileAbs: string, content: string, overwrite: boolean): Promise<void> {
  try {
    if (!overwrite) {
      await fs.access(fileAbs);
      return;
    }
  } catch {
    // missing => proceed
  }
  await fs.mkdir(path.dirname(fileAbs), { recursive: true });
  await fs.writeFile(fileAbs, content, 'utf-8');
}

export async function applyRtwsSeed(params: {
  rtwsRootAbs: string;
  appId: string;
  manifest: DomindsAppManifest;
  overwrite: boolean;
}): Promise<void> {
  const rtwsAppDirAbs = path.resolve(params.rtwsRootAbs, '.apps', params.appId);
  await fs.mkdir(rtwsAppDirAbs, { recursive: true });

  const taskdocs = params.manifest.contributes?.rtwsSeed?.taskdocs ?? [];
  for (const td of taskdocs) {
    const rel = ensureRelNoTraversal(td.path);
    if (!rel.endsWith('.tsk')) {
      throw new Error(`Invalid rtwsSeed taskdoc path (must end with .tsk): ${td.path}`);
    }
    const dirAbs = path.resolve(rtwsAppDirAbs, rel);
    await fs.mkdir(dirAbs, { recursive: true });
    if (typeof td.goals === 'string' && td.goals.trim() !== '') {
      await writeIfMissing(path.join(dirAbs, 'goals.md'), td.goals, params.overwrite);
    }
    if (typeof td.constraints === 'string' && td.constraints.trim() !== '') {
      await writeIfMissing(path.join(dirAbs, 'constraints.md'), td.constraints, params.overwrite);
    }
    if (typeof td.progress === 'string' && td.progress.trim() !== '') {
      await writeIfMissing(path.join(dirAbs, 'progress.md'), td.progress, params.overwrite);
    }
  }
}
