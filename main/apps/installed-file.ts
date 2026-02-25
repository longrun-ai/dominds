import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { formatUnifiedTimestamp } from '../shared/utils/time';

import type { DomindsAppInstallJsonV1 } from './app-json';

export type InstalledAppsSchemaVersion = 1;

export type InstalledAppSource =
  | Readonly<{
      kind: 'npx';
      spec: string;
    }>
  | Readonly<{
      kind: 'local';
      pathAbs: string;
    }>;

export type InstalledAppRuntime = Readonly<{
  port: number | null;
}>;

export type InstalledAppEntry = Readonly<{
  id: string;
  enabled: boolean;
  source: InstalledAppSource;
  runtime: InstalledAppRuntime;
  installJson: DomindsAppInstallJsonV1;
  installedAt: string;
  updatedAt: string;
}>;

export type InstalledAppsFile = Readonly<{
  schemaVersion: InstalledAppsSchemaVersion;
  apps: ReadonlyArray<InstalledAppEntry>;
}>;

export const INSTALLED_APPS_REL_PATH = path.join('.apps', 'installed.yaml');

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
): { ok: true; source: InstalledAppSource } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const kind = asString(v['kind']);
  if (kind !== 'npx' && kind !== 'local') {
    return { ok: false, errorText: `Invalid ${at}.kind: expected 'npx'|'local'` };
  }
  if (kind === 'npx') {
    const spec = asString(v['spec']);
    if (!spec || spec.trim() === '')
      return { ok: false, errorText: `Invalid ${at}.spec: required` };
    return { ok: true, source: { kind, spec } };
  }
  const pathAbs = asString(v['pathAbs']);
  if (!pathAbs || pathAbs.trim() === '')
    return { ok: false, errorText: `Invalid ${at}.pathAbs: required` };
  return { ok: true, source: { kind, pathAbs } };
}

function parseRuntime(
  v: unknown,
  at: string,
): { ok: true; runtime: InstalledAppRuntime } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const portRaw = v['port'];
  const port = asNullableNumber(portRaw);
  if (port === null) {
    if (portRaw !== null) {
      return { ok: false, errorText: `Invalid ${at}.port: expected number|null` };
    }
    return { ok: true, runtime: { port: null } };
  }
  if (port < 0 || !Number.isInteger(port))
    return { ok: false, errorText: `Invalid ${at}.port: expected non-negative integer|null` };
  return { ok: true, runtime: { port: port } };
}

function parseEntry(
  v: unknown,
  at: string,
): { ok: true; entry: InstalledAppEntry } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };
  const enabled = asBool(v['enabled']);
  if (enabled === null) return { ok: false, errorText: `Invalid ${at}.enabled: boolean required` };
  const installedAt = asString(v['installedAt']);
  const updatedAt = asString(v['updatedAt']);
  if (!installedAt || installedAt.trim() === '')
    return { ok: false, errorText: `Invalid ${at}.installedAt: required` };
  if (!updatedAt || updatedAt.trim() === '')
    return { ok: false, errorText: `Invalid ${at}.updatedAt: required` };
  const sourceParsed = parseSource(v['source'], `${at}.source`);
  if (!sourceParsed.ok) return sourceParsed;
  const runtimeParsed = parseRuntime(v['runtime'] ?? { port: null }, `${at}.runtime`);
  if (!runtimeParsed.ok) return runtimeParsed;

  // installJson is validated by install/update command on write. On read we keep permissive:
  // kernel will fail fast later if it needs a missing field.
  const installJson = v['installJson'];
  if (!isRecord(installJson))
    return { ok: false, errorText: `Invalid ${at}.installJson: expected object` };

  return {
    ok: true,
    entry: {
      id,
      enabled,
      source: sourceParsed.source,
      runtime: runtimeParsed.runtime,
      installJson: installJson as unknown as DomindsAppInstallJsonV1,
      installedAt,
      updatedAt,
    },
  };
}

export async function loadInstalledAppsFile(params: {
  rtwsRootAbs: string;
}): Promise<
  | Readonly<{ kind: 'ok'; file: InstalledAppsFile; filePathAbs: string }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, INSTALLED_APPS_REL_PATH);
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
      return { kind: 'ok', filePathAbs, file: { schemaVersion: 1, apps: [] } };
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
    return { kind: 'error', filePathAbs, errorText: 'Invalid installed.yaml: expected object' };
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
      errorText: 'Invalid installed.yaml: apps must be an array',
    };
  }
  const apps: InstalledAppEntry[] = [];
  for (let i = 0; i < appsRaw.length; i += 1) {
    const e = parseEntry(appsRaw[i], `apps[${i}]`);
    if (!e.ok) return { kind: 'error', filePathAbs, errorText: e.errorText };
    apps.push(e.entry);
  }

  return { kind: 'ok', filePathAbs, file: { schemaVersion: 1, apps } };
}

export async function writeInstalledAppsFile(params: {
  rtwsRootAbs: string;
  file: InstalledAppsFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, INSTALLED_APPS_REL_PATH);
  const yamlText = YAML.stringify(params.file);
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export function upsertInstalledApp(params: {
  existing: InstalledAppsFile;
  next: InstalledAppEntry;
}): InstalledAppsFile {
  const apps = [...params.existing.apps];
  const idx = apps.findIndex((a) => a.id === params.next.id);
  if (idx >= 0) {
    apps[idx] = params.next;
  } else {
    apps.push(params.next);
  }
  return { schemaVersion: 1, apps };
}

export function removeInstalledApp(params: {
  existing: InstalledAppsFile;
  appId: string;
}): InstalledAppsFile {
  return { schemaVersion: 1, apps: params.existing.apps.filter((a) => a.id !== params.appId) };
}

export function setAppEnabled(params: {
  existing: InstalledAppsFile;
  appId: string;
  enabled: boolean;
}): InstalledAppsFile {
  const now = formatUnifiedTimestamp(new Date());
  const apps = params.existing.apps.map((a) =>
    a.id === params.appId ? { ...a, enabled: params.enabled, updatedAt: now } : a,
  );
  return { schemaVersion: 1, apps };
}

export function setAppRuntimePort(params: {
  existing: InstalledAppsFile;
  appId: string;
  port: number | null;
}): InstalledAppsFile {
  const now = formatUnifiedTimestamp(new Date());
  const apps = params.existing.apps.map((a) =>
    a.id === params.appId
      ? { ...a, runtime: { ...a.runtime, port: params.port }, updatedAt: now }
      : a,
  );
  return { schemaVersion: 1, apps };
}

export function findInstalledApp(file: InstalledAppsFile, appId: string): InstalledAppEntry | null {
  const found = file.apps.find((a) => a.id === appId);
  return found ?? null;
}
