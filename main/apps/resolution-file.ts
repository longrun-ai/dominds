import fs from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import {
  parseDomindsAppInstallJson,
  type DomindsAppInstallJsonV1,
} from '@longrun-ai/kernel/app-json';

export type AppsResolutionSchemaVersion = 1;

export type AppsResolutionSource =
  | Readonly<{
      kind: 'npx';
      spec: string;
    }>
  | Readonly<{
      kind: 'local';
      pathAbs: string;
    }>;

export type AppsResolutionEntry = Readonly<{
  id: string;
  enabled: boolean;
  source: AppsResolutionSource;
  assignedPort: number | null;
  installJson: DomindsAppInstallJsonV1;
}>;

export type AppsResolutionFile = Readonly<{
  schemaVersion: AppsResolutionSchemaVersion;
  apps: ReadonlyArray<AppsResolutionEntry>;
}>;

export const APPS_RESOLUTION_REL_PATH = path.join('.apps', 'resolution.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asNullableNumber(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
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
    const spec = asString(v['spec']);
    if (!spec || spec.trim() === '') {
      return { ok: false, errorText: `Invalid ${at}.spec: required` };
    }
    return { ok: true, source: { kind, spec } };
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
): { ok: true; entry: AppsResolutionEntry } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };

  const enabled = asBool(v['enabled']);
  if (enabled === null) return { ok: false, errorText: `Invalid ${at}.enabled: boolean required` };

  const assignedPortRaw = v['assignedPort'] ?? null;
  const assignedPort = asNullableNumber(assignedPortRaw);
  if (assignedPort === null) {
    if (assignedPortRaw !== null) {
      return { ok: false, errorText: `Invalid ${at}.assignedPort: expected number|null` };
    }
  } else if (!Number.isInteger(assignedPort) || assignedPort <= 0) {
    return { ok: false, errorText: `Invalid ${at}.assignedPort: expected positive integer|null` };
  }

  const sourceParsed = parseSource(v['source'], `${at}.source`);
  if (!sourceParsed.ok) return sourceParsed;

  const installJsonParsed = parseDomindsAppInstallJson(v['installJson']);
  if (!installJsonParsed.ok) {
    return { ok: false, errorText: `Invalid ${at}.installJson: ${installJsonParsed.errorText}` };
  }

  return {
    ok: true,
    entry: {
      id: id.trim(),
      enabled,
      source: sourceParsed.source,
      assignedPort,
      installJson: installJsonParsed.json,
    },
  };
}

function canonicalizeResolutionFile(file: AppsResolutionFile): AppsResolutionFile {
  const byId = new Map<string, AppsResolutionEntry>();
  for (const entry of file.apps) {
    if (byId.has(entry.id)) {
      throw new Error(`Invalid ${APPS_RESOLUTION_REL_PATH}: duplicate app id '${entry.id}'`);
    }
    byId.set(entry.id, entry);
  }
  return {
    schemaVersion: 1,
    apps: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function loadAppsResolutionFile(params: {
  rtwsRootAbs: string;
}): Promise<
  | Readonly<{ kind: 'ok'; file: AppsResolutionFile; filePathAbs: string; exists: boolean }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
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

  if (!isRecord(parsed)) {
    return { kind: 'error', filePathAbs, errorText: 'Invalid resolution.yaml: expected object' };
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (key !== 'schemaVersion' && key !== 'apps') {
      return {
        kind: 'error',
        filePathAbs,
        errorText: `Invalid resolution.yaml: unknown key '${key}'`,
      };
    }
  }

  const schemaVersion = parsed['schemaVersion'];
  if (schemaVersion !== 1) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: `Unsupported schemaVersion: ${String(schemaVersion)}`,
    };
  }

  const appsRaw = parsed['apps'];
  if (!Array.isArray(appsRaw)) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: 'Invalid resolution.yaml: apps must be an array',
    };
  }

  const apps: AppsResolutionEntry[] = [];
  for (let i = 0; i < appsRaw.length; i += 1) {
    const entryParsed = parseEntry(appsRaw[i], `apps[${i}]`);
    if (!entryParsed.ok) return { kind: 'error', filePathAbs, errorText: entryParsed.errorText };
    apps.push(entryParsed.entry);
  }

  try {
    return {
      kind: 'ok',
      filePathAbs,
      exists: true,
      file: canonicalizeResolutionFile({ schemaVersion: 1, apps }),
    };
  } catch (err: unknown) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function writeAppsResolutionFile(params: {
  rtwsRootAbs: string;
  file: AppsResolutionFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const yamlText = YAML.stringify(canonicalizeResolutionFile(params.file));
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export async function writeAppsResolutionFileIfChanged(params: {
  rtwsRootAbs: string;
  file: AppsResolutionFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const yamlText = YAML.stringify(canonicalizeResolutionFile(params.file));
  try {
    const prev = await fs.readFile(filePathAbs, 'utf-8');
    if (prev === yamlText) return;
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (!isEnoent) throw err;
  }
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export function findResolvedApp(
  file: AppsResolutionFile,
  appId: string,
): AppsResolutionEntry | null {
  return file.apps.find((app) => app.id === appId) ?? null;
}

export function upsertResolvedApp(params: {
  existing: AppsResolutionFile;
  next: AppsResolutionEntry;
}): AppsResolutionFile {
  const apps = [...params.existing.apps];
  const idx = apps.findIndex((app) => app.id === params.next.id);
  if (idx >= 0) apps[idx] = params.next;
  else apps.push(params.next);
  return canonicalizeResolutionFile({ schemaVersion: 1, apps });
}

export function removeResolvedApp(params: {
  existing: AppsResolutionFile;
  appId: string;
}): AppsResolutionFile {
  if (!params.existing.apps.some((app) => app.id === params.appId)) return params.existing;
  return canonicalizeResolutionFile({
    schemaVersion: 1,
    apps: params.existing.apps.filter((app) => app.id !== params.appId),
  });
}

export function setResolvedAppEnabled(params: {
  existing: AppsResolutionFile;
  appId: string;
  enabled: boolean;
}): AppsResolutionFile {
  const existingApp = findResolvedApp(params.existing, params.appId);
  if (!existingApp || existingApp.enabled === params.enabled) return params.existing;
  return canonicalizeResolutionFile({
    schemaVersion: 1,
    apps: params.existing.apps.map((app) =>
      app.id === params.appId ? { ...app, enabled: params.enabled } : app,
    ),
  });
}

export function setResolvedAppAssignedPort(params: {
  existing: AppsResolutionFile;
  appId: string;
  assignedPort: number | null;
}): AppsResolutionFile {
  if (params.assignedPort !== null) {
    if (!Number.isInteger(params.assignedPort) || params.assignedPort <= 0) {
      throw new Error(
        `Invalid assignedPort: expected positive integer|null (got ${params.assignedPort})`,
      );
    }
  }
  const existingApp = findResolvedApp(params.existing, params.appId);
  if (!existingApp || existingApp.assignedPort === params.assignedPort) return params.existing;
  return canonicalizeResolutionFile({
    schemaVersion: 1,
    apps: params.existing.apps.map((app) =>
      app.id === params.appId ? { ...app, assignedPort: params.assignedPort } : app,
    ),
  });
}
