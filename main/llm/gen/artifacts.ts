/**
 * Module: llm/gen/artifacts
 *
 * Helpers for reading persisted dialog artifacts (e.g., MCP screenshots) from disk.
 */

import fsPromises from 'fs/promises';
import * as path from 'path';
import { DialogID } from '../../dialog';
import { DialogPersistence } from '../../persistence';

export type DialogArtifactIdent = {
  rootId: string;
  selfId: string;
  // Relative to the dialog events directory (DialogPersistence.getDialogEventsPath).
  // Must start with "artifacts/".
  relPath: string;
};

export type VisionImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export function isVisionImageMimeType(mimeType: string): mimeType is VisionImageMimeType {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return true;
    default:
      return false;
  }
}

export function bytesToDataUrl(params: { mimeType: string; bytes: Buffer }): string {
  const base64 = params.bytes.toString('base64');
  return `data:${params.mimeType};base64,${base64}`;
}

export function normalizeDialogArtifactRelPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.includes('\u0000')) return null;
  if (trimmed.includes('\\')) return null;
  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes(':')) return null;

  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith('artifacts/')) return null;
  if (normalized.endsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return normalized;
}

function ensureTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

export async function locateDialogArtifactFilePath(params: {
  rootId: string;
  selfId: string;
  relPath: string;
}): Promise<string | null> {
  const relPath = normalizeDialogArtifactRelPath(params.relPath);
  if (!relPath) return null;

  const statusCandidates: Array<'running' | 'completed' | 'archived'> = [
    'running',
    'completed',
    'archived',
  ];
  for (const status of statusCandidates) {
    const baseDir = DialogPersistence.getDialogEventsPath(
      new DialogID(params.selfId, params.rootId),
      status,
    );
    const candidatePath = path.join(baseDir, ...relPath.split('/'));
    const baseAbs = ensureTrailingSep(path.resolve(baseDir));
    const candAbs = path.resolve(candidatePath);
    if (!candAbs.startsWith(baseAbs)) continue;
    try {
      const st = await fsPromises.stat(candAbs);
      if (!st.isFile()) continue;
      return candAbs;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === 'ENOENT') continue;
      throw error;
    }
  }
  return null;
}

export async function readDialogArtifactBytes(params: DialogArtifactIdent): Promise<Buffer | null> {
  const absPath = await locateDialogArtifactFilePath(params);
  if (!absPath) return null;
  const data = await fsPromises.readFile(absPath);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
