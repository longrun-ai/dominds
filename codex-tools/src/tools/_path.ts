import path from 'node:path';

export function assertRelativePath(input: string, label: string): void {
  if (path.isAbsolute(input)) {
    throw new Error(`${label} must be a relative path: ${input}`);
  }
  // Disallow Windows drive-letter style absolute paths on non-win too.
  if (/^[a-zA-Z]:[\\/]/.test(input)) {
    throw new Error(`${label} must be a relative path: ${input}`);
  }
}

export function resolveInWorkspace(workspaceRoot: string, relPath: string, label: string): string {
  assertRelativePath(relPath, label);
  const resolved = path.resolve(workspaceRoot, relPath);
  const root = path.resolve(workspaceRoot);
  if (resolved === root) {
    return resolved;
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`${label} escapes workspace root: ${relPath}`);
  }
  return resolved;
}
