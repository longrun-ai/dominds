import * as fs from 'node:fs/promises';
import path from 'node:path';

/** Authoritative/derived App compatibility files: byte and mtime preservation, not prose meaning. */
export async function readAppStateFiles(rtws: string) {
  const states = [];
  for (const relative of [
    '.minds/app.yaml',
    '.minds/app-lock.yaml',
    '.apps/configuration.yaml',
    '.apps/resolution.yaml',
  ]) {
    const file = path.join(rtws, relative);
    try {
      const bytes = await fs.readFile(file);
      const stat = await fs.stat(file);
      states.push({ relative, bytes: bytes.toString('base64'), mtimeMs: stat.mtimeMs });
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      states.push({ relative, bytes: null, mtimeMs: null });
    }
  }
  return states;
}
