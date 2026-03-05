import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import YAML from 'yaml';

import type { AppsResolutionSource } from './resolution-file';

export type AppLockSchemaVersion = 1;

export type AppLockEntry = Readonly<{
  id: string;
  source: AppsResolutionSource;
  package: Readonly<{
    name: string;
    version: string | null;
  }>;
}>;

export type AppLockFile = Readonly<{
  schemaVersion: AppLockSchemaVersion;
  apps: ReadonlyArray<AppLockEntry>;
}>;

export const APP_LOCK_REL_PATH = path.join('.minds', 'app-lock.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : null;
}

function parseSource(
  v: unknown,
  at: string,
): { ok: true; source: AppsResolutionSource } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const kind = asString(v['kind']);
  if (kind !== 'npx' && kind !== 'local') {
    return { ok: false, errorText: `Invalid ${at}.kind: expected 'npx'|'local'` };
  }

  if (kind === 'npx') {
    const keys = Object.keys(v);
    for (const k of keys) {
      if (k !== 'kind' && k !== 'spec') {
        return { ok: false, errorText: `Invalid ${at}: unknown key '${k}'` };
      }
    }
    const spec = asString(v['spec']);
    if (!spec || spec.trim() === '') {
      return { ok: false, errorText: `Invalid ${at}.spec: required` };
    }
    return { ok: true, source: { kind, spec } };
  }

  const keys = Object.keys(v);
  for (const k of keys) {
    if (k !== 'kind' && k !== 'pathAbs') {
      return { ok: false, errorText: `Invalid ${at}: unknown key '${k}'` };
    }
  }
  const pathAbs = asString(v['pathAbs']);
  if (!pathAbs || pathAbs.trim() === '') {
    return { ok: false, errorText: `Invalid ${at}.pathAbs: required` };
  }
  return { ok: true, source: { kind, pathAbs } };
}

function parseEntry(
  v: unknown,
  at: string,
): { ok: true; entry: AppLockEntry } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };

  const keys = Object.keys(v);
  for (const k of keys) {
    if (k !== 'id' && k !== 'source' && k !== 'package') {
      return { ok: false, errorText: `Invalid ${at}: unknown key '${k}'` };
    }
  }

  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };

  const sourceParsed = parseSource(v['source'], `${at}.source`);
  if (!sourceParsed.ok) return sourceParsed;

  const pkg = v['package'];
  if (!isRecord(pkg)) {
    return { ok: false, errorText: `Invalid ${at}.package: expected object` };
  }
  const pkgKeys = Object.keys(pkg);
  for (const k of pkgKeys) {
    if (k !== 'name' && k !== 'version') {
      return { ok: false, errorText: `Invalid ${at}.package: unknown key '${k}'` };
    }
  }
  const name = asString(pkg['name']);
  if (!name || name.trim() === '') {
    return { ok: false, errorText: `Invalid ${at}.package.name: required` };
  }
  const versionRaw = pkg['version'] ?? null;
  const version = asNullableString(versionRaw);
  if (version === null) {
    if (versionRaw !== null) {
      return { ok: false, errorText: `Invalid ${at}.package.version: expected string|null` };
    }
  } else if (version.trim() === '') {
    return { ok: false, errorText: `Invalid ${at}.package.version: must not be empty` };
  }

  return {
    ok: true,
    entry: {
      id,
      source: sourceParsed.source,
      package: { name, version },
    },
  };
}

function canonicalizeLockFile(file: AppLockFile): AppLockFile {
  const byId = new Map<string, AppLockEntry>();
  for (const e of file.apps) {
    if (byId.has(e.id)) {
      throw new Error(`Invalid ${APP_LOCK_REL_PATH}: duplicate app id '${e.id}'`);
    }
    byId.set(e.id, e);
  }
  const apps = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 1, apps };
}

export function parseAppLockFile(
  parsed: unknown,
  filePathAbs: string,
): { ok: true; file: AppLockFile } | { ok: false; errorText: string } {
  if (!isRecord(parsed)) {
    return { ok: false, errorText: `Invalid app-lock.yaml: expected object (${filePathAbs})` };
  }

  const keys = Object.keys(parsed);
  for (const k of keys) {
    if (k !== 'schemaVersion' && k !== 'apps') {
      return { ok: false, errorText: `Invalid app-lock.yaml: unknown key '${k}' (${filePathAbs})` };
    }
  }

  const schemaVersion = parsed['schemaVersion'];
  if (schemaVersion !== 1) {
    return {
      ok: false,
      errorText: `Unsupported app-lock.yaml schemaVersion: ${String(schemaVersion)} (${filePathAbs})`,
    };
  }

  const appsRaw = parsed['apps'];
  if (!Array.isArray(appsRaw)) {
    return {
      ok: false,
      errorText: `Invalid app-lock.yaml: apps must be an array (${filePathAbs})`,
    };
  }

  const apps: AppLockEntry[] = [];
  for (let i = 0; i < appsRaw.length; i += 1) {
    const e = parseEntry(appsRaw[i], `apps[${i}]`);
    if (!e.ok) return { ok: false, errorText: `${e.errorText} (${filePathAbs})` };
    apps.push(e.entry);
  }

  try {
    return { ok: true, file: canonicalizeLockFile({ schemaVersion: 1, apps }) };
  } catch (err: unknown) {
    return {
      ok: false,
      errorText: `${err instanceof Error ? err.message : String(err)} (${filePathAbs})`,
    };
  }
}

export async function loadAppLockFile(params: {
  rtwsRootAbs: string;
}): Promise<
  | Readonly<{ kind: 'ok'; file: AppLockFile; filePathAbs: string; exists: boolean }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APP_LOCK_REL_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(filePathAbs, 'utf-8');
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) {
      return { kind: 'ok', filePathAbs, exists: false, file: { schemaVersion: 1, apps: [] } };
    }
    return {
      kind: 'error',
      filePathAbs,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err: unknown) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lockParsed = parseAppLockFile(parsed, filePathAbs);
  if (!lockParsed.ok) return { kind: 'error', filePathAbs, errorText: lockParsed.errorText };
  return { kind: 'ok', filePathAbs, exists: true, file: lockParsed.file };
}

export function upsertLockedApp(params: {
  existing: AppLockFile;
  next: AppLockEntry;
}): AppLockFile {
  const existingEntry = params.existing.apps.find((a) => a.id === params.next.id) ?? null;
  if (existingEntry && isDeepStrictEqual(existingEntry, params.next)) return params.existing;

  const apps = [...params.existing.apps];
  const idx = apps.findIndex((a) => a.id === params.next.id);
  if (idx >= 0) apps[idx] = params.next;
  else apps.push(params.next);
  return canonicalizeLockFile({ schemaVersion: 1, apps });
}

export async function writeAppLockFileIfChanged(params: {
  rtwsRootAbs: string;
  file: AppLockFile;
}): Promise<void> {
  const canonical = canonicalizeLockFile(params.file);
  const loaded = await loadAppLockFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loaded.kind === 'error') {
    // Avoid overwriting user edits if the existing file is corrupt.
    throw new Error(`Failed to read ${APP_LOCK_REL_PATH}: ${loaded.errorText}`);
  }
  if (loaded.exists) {
    const prevCanonical = canonicalizeLockFile(loaded.file);
    if (isDeepStrictEqual(prevCanonical, canonical)) return;
  } else {
    if (canonical.apps.length === 0) return;
  }

  const mindsDirAbs = path.resolve(params.rtwsRootAbs, '.minds');
  await fs.mkdir(mindsDirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APP_LOCK_REL_PATH);
  const yamlText = YAML.stringify(canonical);
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}
